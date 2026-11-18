// Document store with two backends that share one small interface:
//   get(path) -> object | null
//   set(path, data)                      overwrite
//   create(path, data) -> boolean        false when the document already exists
//   patch(path, { 'a.b': value })        set fields (dotted keys reach into maps); document must exist
//   list(collection, { orderBy, desc, limit }) -> [{ id, ...data }]
// Paths look like "workspaces/ws_1/posts/p_1". Timestamps are stored as ISO strings.
// FirestoreStore talks to the Firestore REST API directly, so the hub has no dependencies.

export class MemoryStore {
  constructor() {
    this.docs = new Map();
  }
  async get(p) {
    const d = this.docs.get(p);
    return d ? structuredClone(d) : null;
  }
  async set(p, data) {
    this.docs.set(p, structuredClone(data));
  }
  async create(p, data) {
    if (this.docs.has(p)) return false;
    await this.set(p, data);
    return true;
  }
  async patch(p, fields) {
    const d = this.docs.get(p);
    if (!d) throw new Error(`not found: ${p}`);
    for (const [k, v] of Object.entries(fields)) setPath(d, k.split('.'), structuredClone(v));
  }
  async list(coll, { orderBy, desc = false, limit = 100 } = {}) {
    const prefix = `${coll}/`;
    const rows = [];
    for (const [k, v] of this.docs) {
      if (!k.startsWith(prefix)) continue;
      const id = k.slice(prefix.length);
      if (!id.includes('/')) rows.push({ id, ...structuredClone(v) });
    }
    if (orderBy) rows.sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0) * (desc ? -1 : 1));
    return rows.slice(0, limit);
  }
}

export class FirestoreStore {
  constructor({ project, database = '(default)' }) {
    if (!project) throw new Error('FirestoreStore needs a project id');
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    this.emulator = Boolean(emulator);
    const origin = emulator ? `http://${emulator}` : 'https://firestore.googleapis.com';
    this.base = `${origin}/v1/projects/${project}/databases/${database}/documents`;
    this.token = null;
    this.tokenExpires = 0;
  }

  async get(p) {
    const r = await this.call('GET', `${this.base}/${p}`);
    if (r.status === 404) return null;
    return decodeFields((await ok(r)).fields);
  }
  async set(p, data) {
    await ok(await this.call('PATCH', `${this.base}/${p}`, { fields: encodeFields(data) }));
  }
  async create(p, data) {
    const r = await this.call('PATCH', `${this.base}/${p}?currentDocument.exists=false`, { fields: encodeFields(data) });
    if (r.status === 409 || r.status === 400) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 409 || body.error?.status === 'FAILED_PRECONDITION' || body.error?.status === 'ALREADY_EXISTS') return false;
      throw new Error(`firestore ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    await ok(r);
    return true;
  }
  async patch(p, fields) {
    const nested = {};
    const qs = new URLSearchParams({ 'currentDocument.exists': 'true' });
    for (const [k, v] of Object.entries(fields)) {
      setPath(nested, k.split('.'), v);
      qs.append('updateMask.fieldPaths', k);
    }
    await ok(await this.call('PATCH', `${this.base}/${p}?${qs}`, { fields: encodeFields(nested) }));
  }
  async list(coll, { orderBy, desc = false, limit = 100 } = {}) {
    const parts = coll.split('/');
    const collectionId = parts.pop();
    const parent = parts.length ? `${this.base}/${parts.join('/')}` : this.base;
    const structuredQuery = { from: [{ collectionId }], limit };
    if (orderBy) structuredQuery.orderBy = [{ field: { fieldPath: orderBy }, direction: desc ? 'DESCENDING' : 'ASCENDING' }];
    const rows = await ok(await this.call('POST', `${parent}:runQuery`, { structuredQuery }));
    return rows.filter((x) => x.document).map((x) => ({ id: x.document.name.split('/').pop(), ...decodeFields(x.document.fields) }));
  }

  async call(method, url, body) {
    return fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  }
  // On Cloud Run the token comes from the metadata server (the service account of the
  // revision). For a local run against the real database, pass FIRESTORE_ACCESS_TOKEN.
  async accessToken() {
    if (this.emulator) return 'owner';
    if (process.env.FIRESTORE_ACCESS_TOKEN) return process.env.FIRESTORE_ACCESS_TOKEN;
    if (this.token && Date.now() < this.tokenExpires) return this.token;
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    const t = await ok(r);
    this.token = t.access_token;
    this.tokenExpires = Date.now() + (t.expires_in - 120) * 1000;
    return this.token;
  }
}

async function ok(r) {
  if (!r.ok) throw new Error(`firestore ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function setPath(obj, keys, value) {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

export function encodeFields(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]));
}
function encode(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`cannot encode ${typeof v}`);
}
export function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));
}
function decode(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return null;
}
