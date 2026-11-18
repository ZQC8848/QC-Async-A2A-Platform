// HTTP API of the hub. createApp(store, { adminToken }) returns a Node request handler.
//
// Auth: members send `X-QCA2A-Token: qca.<memberId>.<secret>`; only a SHA-256 of the
// secret is stored. Every /ws/:id route checks that the member belongs to that workspace.
// /admin routes take the single admin token (the hub owner).
//
//   GET  /health
//   POST /join                       { invite, name }  -> member token (or adds a workspace to the caller)
//   GET  /me
//   GET  /ws/:id/inbox[?mark=1]      unread posts; `fresh` = created since the last marked check
//   GET  /ws/:id/posts[?limit=]      recent posts with read receipts
//   POST /ws/:id/posts               { type, title, body, links, to: [member names] }
//   GET  /ws/:id/posts/:pid
//   POST /ws/:id/posts/:pid/read
//   GET  /admin/workspaces
//   POST /admin/workspaces           { name }
//   POST /admin/invites              { workspace, uses, days }
//   POST /admin/revoke               { member }

import crypto from 'node:crypto';

const POST_TYPES = ['note', 'decision', 'task', 'notice'];
const MAX_BODY = 256 * 1024;

export function createApp(store, { adminToken }) {
  if (!adminToken || adminToken.length < 32) throw new Error('adminToken missing or shorter than 32 chars');

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://hub');
      const seg = url.pathname.split('/').filter(Boolean);
      const key = `${req.method} /${seg.join('/')}`;

      if (key === 'GET /health') return send(res, 200, { ok: true });

      if (seg[0] === 'admin') {
        if (!safeEqual(bearer(req), adminToken)) throw new HttpError(401, 'admin token required');
        return send(res, 200, await admin(key, req));
      }
      if (key === 'POST /join') return send(res, 200, await join(req));

      const me = await authenticate(req);
      if (!me) throw new HttpError(401, 'invalid or revoked token');
      if (key === 'GET /me') return send(res, 200, await whoami(me));

      if (seg[0] === 'ws' && seg[1]) {
        const ws = await store.get(`workspaces/${seg[1]}`);
        // Same answer for "no such workspace" and "not a member", so ids cannot be probed.
        if (!ws || !ws.members?.[me.id]) throw new HttpError(403, 'not a member of this workspace');
        const out = await workspace({ method: req.method, rest: seg.slice(2), url, req, me, ws, wsId: seg[1] });
        if (out) return send(res, 200, out);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'internal error' });
    }
  };

  async function admin(key, req) {
    if (key === 'GET /admin/workspaces') {
      const rows = await store.list('workspaces', { limit: 200 });
      return { workspaces: rows.map((w) => ({ id: w.id, name: w.name, members: w.members })) };
    }
    const body = await readJson(req);
    if (key === 'POST /admin/workspaces') {
      const name = str(body.name, 'name', 80);
      const id = newId('ws');
      await store.set(`workspaces/${id}`, { name, createdAt: now(), members: {} });
      return { id, name };
    }
    if (key === 'POST /admin/invites') {
      const wsId = str(body.workspace, 'workspace', 40);
      const ws = await store.get(`workspaces/${wsId}`);
      if (!ws) throw new HttpError(404, 'no such workspace');
      const uses = clamp(body.uses ?? 1, 1, 50);
      const days = clamp(body.days ?? 7, 1, 30);
      const code = `inv.${crypto.randomBytes(18).toString('base64url')}`;
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      await store.set(`invites/${sha(code)}`, { workspace: wsId, usesLeft: uses, expiresAt });
      return { invite: code, workspace: { id: wsId, name: ws.name }, uses, expiresAt };
    }
    if (key === 'POST /admin/revoke') {
      const id = str(body.member, 'member', 40);
      if (!(await store.get(`members/${id}`))) throw new HttpError(404, 'no such member');
      await store.patch(`members/${id}`, { revoked: true });
      return { revoked: id };
    }
    throw new HttpError(404, 'not found');
  }

  // A new person gets a member record and a token. Someone who already has a token and
  // sends it with the request is added to the invite's workspace instead (one person,
  // many workspaces). The use counter is not transactional: fine for a handful of people.
  async function join(req) {
    const body = await readJson(req);
    const invitePath = `invites/${sha(str(body.invite, 'invite', 200))}`;
    const inv = await store.get(invitePath);
    if (!inv || inv.usesLeft < 1 || inv.expiresAt < now()) throw new HttpError(403, 'invite is invalid, used up or expired');
    const ws = await store.get(`workspaces/${inv.workspace}`);
    if (!ws) throw new HttpError(403, 'invite is invalid, used up or expired');

    let me = await authenticate(req);
    const name = me ? me.name : str(body.name, 'name', 40);
    if (!me || !ws.members[me.id]) {
      const taken = Object.values(ws.members).some((n) => n.toLowerCase() === name.toLowerCase());
      if (taken) throw new HttpError(409, `the name "${name}" is already used in this workspace`);
    }
    let token;
    if (!me) {
      const id = newId('m');
      const secret = crypto.randomBytes(32).toString('base64url');
      token = `qca.${id}.${secret}`;
      me = { id, name };
      await store.set(`members/${id}`, { name, tokenHash: sha(secret), createdAt: now(), revoked: false, workspaces: {} });
    }
    await store.patch(`members/${me.id}`, { [`workspaces.${inv.workspace}`]: true });
    await store.patch(`workspaces/${inv.workspace}`, { [`members.${me.id}`]: me.name });
    await store.patch(invitePath, { usesLeft: inv.usesLeft - 1 });
    return { member: { id: me.id, name: me.name }, token, workspace: { id: inv.workspace, name: ws.name } };
  }

  async function whoami(me) {
    const workspaces = [];
    for (const id of Object.keys(me.workspaces || {})) {
      const ws = await store.get(`workspaces/${id}`);
      if (ws?.members?.[me.id]) workspaces.push({ id, name: ws.name, members: Object.values(ws.members) });
    }
    return { member: { id: me.id, name: me.name }, workspaces };
  }

  async function workspace({ method, rest, url, req, me, ws, wsId }) {
    const posts = `workspaces/${wsId}/posts`;
    const route = `${method} ${rest.join('/')}`;

    if (route === 'GET inbox') {
      const cursorPath = `workspaces/${wsId}/cursors/${me.id}`;
      const cursor = (await store.get(cursorPath)) ?? { notifiedAt: '' };
      const rows = await store.list(posts, { orderBy: 'createdAt', desc: true, limit: 100 });
      const unread = rows.filter((p) => p.author !== me.id && !p.readBy?.[me.id]).map((p) => brief(p, me));
      const fresh = unread.filter((p) => p.createdAt > cursor.notifiedAt);
      if (url.searchParams.get('mark') === '1') await store.set(cursorPath, { notifiedAt: now() });
      return { workspace: { id: wsId, name: ws.name }, unread, fresh };
    }
    if (route === 'GET posts') {
      const limit = clamp(Number(url.searchParams.get('limit') ?? 20), 1, 100);
      const rows = await store.list(posts, { orderBy: 'createdAt', desc: true, limit });
      return { posts: rows.map((p) => ({ ...brief(p, me), readBy: readers(p, ws) })) };
    }
    if (route === 'POST posts') {
      const body = await readJson(req);
      if (!POST_TYPES.includes(body.type)) throw new HttpError(400, `type must be one of ${POST_TYPES.join(', ')}`);
      const names = Object.entries(ws.members);
      const mentions = (Array.isArray(body.to) ? body.to : []).map((n) => {
        const hit = names.find(([, name]) => name.toLowerCase() === String(n).toLowerCase());
        if (!hit) throw new HttpError(400, `no member named "${n}" in this workspace (members: ${names.map(([, x]) => x).join(', ')})`);
        return hit[0];
      });
      const id = `p_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const post = {
        author: me.id,
        authorName: me.name,
        type: body.type,
        title: str(body.title, 'title', 200),
        body: typeof body.body === 'string' ? body.body.slice(0, 50_000) : '',
        links: (Array.isArray(body.links) ? body.links : []).slice(0, 20).map((l) => String(l).slice(0, 500)),
        mentions,
        createdAt: now(),
        readBy: {},
      };
      await store.set(`${posts}/${id}`, post);
      return { id, ...brief({ id, ...post }, me) };
    }
    if (rest[0] === 'posts' && rest[1]) {
      const path = `${posts}/${rest[1]}`;
      const post = await store.get(path);
      if (!post) throw new HttpError(404, 'no such post');
      if (method === 'GET' && rest.length === 2) {
        return { id: rest[1], ...brief({ id: rest[1], ...post }, me), body: post.body, links: post.links, readBy: readers(post, ws) };
      }
      if (route === `POST posts/${rest[1]}/read`) {
        if (post.author !== me.id && !post.readBy?.[me.id]) await store.patch(path, { [`readBy.${me.id}`]: now() });
        return { read: rest[1] };
      }
    }
    return null;
  }

  async function authenticate(req) {
    const m = /^qca\.(m_[a-z0-9]+)\.([\w-]{20,})$/.exec(bearer(req));
    if (!m) return null;
    const member = await store.get(`members/${m[1]}`);
    if (!member || member.revoked || !safeEqual(sha(m[2]), member.tokenHash)) return null;
    return { id: m[1], ...member };
  }
}

function brief(p, me) {
  return { id: p.id, type: p.type, title: p.title, author: p.authorName, createdAt: p.createdAt, forMe: (p.mentions || []).includes(me.id), mine: p.author === me.id };
}
function readers(p, ws) {
  return Object.keys(p.readBy || {}).map((id) => ws.members[id] ?? id);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(n)) || lo));
// The token travels in X-QCA2A-Token, not Authorization: Cloud Run's front end rejects any
// `Authorization: Bearer` value it cannot verify as a Google token before the request gets here.
const bearer = (req) => String(req.headers['x-qca2a-token'] || '');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function str(v, field, max) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
  return v.trim();
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
