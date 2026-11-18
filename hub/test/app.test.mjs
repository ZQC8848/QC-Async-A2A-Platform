import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { MemoryStore, encodeFields, decodeFields } from '../src/store.js';

const ADMIN = 'a'.repeat(40);

async function start() {
  const server = http.createServer(createApp(new MemoryStore(), { adminToken: ADMIN }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-qca2a-token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  return { call, close: () => server.close() };
}

async function workspaceWith(call, names, wsName = 'Team') {
  const ws = (await call('POST', '/admin/workspaces', ADMIN, { name: wsName })).body;
  const inv = (await call('POST', '/admin/invites', ADMIN, { workspace: ws.id, uses: names.length })).body.invite;
  const tokens = {};
  for (const name of names) tokens[name] = (await call('POST', '/join', null, { invite: inv, name })).body.token;
  return { ws, tokens };
}

test('broadcast flow: post, inbox, notified once, read receipt', async () => {
  const { call, close } = await start();
  const { ws, tokens } = await workspaceWith(call, ['Qin', 'Weibo', 'Ana']);

  const posted = await call('POST', `/ws/${ws.id}/posts`, tokens.Qin, { type: 'task', title: 'Review shader', body: 'details', to: ['weibo'] });
  assert.equal(posted.status, 200);

  const mine = await call('GET', `/ws/${ws.id}/inbox?mark=1`, tokens.Qin);
  assert.equal(mine.body.unread.length, 0, 'own posts are never unread');

  const first = await call('GET', `/ws/${ws.id}/inbox?mark=1`, tokens.Weibo);
  assert.equal(first.body.fresh.length, 1);
  assert.equal(first.body.fresh[0].forMe, true);
  const second = await call('GET', `/ws/${ws.id}/inbox?mark=1`, tokens.Weibo);
  assert.equal(second.body.fresh.length, 0, 'already notified');
  assert.equal(second.body.unread.length, 1, 'still unread until read');

  const ana = await call('GET', `/ws/${ws.id}/inbox`, tokens.Ana);
  assert.equal(ana.body.fresh[0].forMe, false);

  const full = await call('GET', `/ws/${ws.id}/posts/${posted.body.id}`, tokens.Weibo);
  assert.equal(full.body.body, 'details');
  await call('POST', `/ws/${ws.id}/posts/${posted.body.id}/read`, tokens.Weibo);
  assert.equal((await call('GET', `/ws/${ws.id}/inbox`, tokens.Weibo)).body.unread.length, 0);

  const list = await call('GET', `/ws/${ws.id}/posts`, tokens.Qin);
  assert.deepEqual(list.body.posts[0].readBy, ['Weibo']);
  close();
});

test('workspaces are isolated and tokens are checked', async () => {
  const { call, close } = await start();
  const a = await workspaceWith(call, ['Qin'], 'A');
  const b = await workspaceWith(call, ['Eve'], 'B');
  await call('POST', `/ws/${a.ws.id}/posts`, a.tokens.Qin, { type: 'note', title: 'secret plan' });

  assert.equal((await call('GET', `/ws/${a.ws.id}/inbox`, b.tokens.Eve)).status, 403);
  assert.equal((await call('GET', `/ws/${a.ws.id}/posts`, b.tokens.Eve)).status, 403);
  assert.equal((await call('GET', `/ws/ws_nope/inbox`, b.tokens.Eve)).status, 403);
  assert.equal((await call('GET', `/ws/${a.ws.id}/inbox`, null)).status, 401);
  assert.equal((await call('GET', `/ws/${a.ws.id}/inbox`, a.tokens.Qin.slice(0, -2) + 'xx')).status, 401);
  assert.equal((await call('GET', '/admin/workspaces', b.tokens.Eve)).status, 401);

  const eveId = (await call('GET', '/me', b.tokens.Eve)).body.member.id;
  await call('POST', '/admin/revoke', ADMIN, { member: eveId });
  assert.equal((await call('GET', '/me', b.tokens.Eve)).status, 401);
  close();
});

test('invites: use count, existing member joins a second workspace, bad input', async () => {
  const { call, close } = await start();
  const a = await workspaceWith(call, ['Qin'], 'A');
  const wsB = (await call('POST', '/admin/workspaces', ADMIN, { name: 'B' })).body;
  const inv = (await call('POST', '/admin/invites', ADMIN, { workspace: wsB.id, uses: 1 })).body.invite;

  const joined = await call('POST', '/join', a.tokens.Qin, { invite: inv });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.token, undefined, 'existing member keeps their token');
  assert.equal((await call('GET', '/me', a.tokens.Qin)).body.workspaces.length, 2);

  assert.equal((await call('POST', '/join', null, { invite: inv, name: 'Late' })).status, 403, 'invite used up');
  assert.equal((await call('POST', '/join', null, { invite: 'inv.nope', name: 'X' })).status, 403);
  assert.equal((await call('POST', `/ws/${wsB.id}/posts`, a.tokens.Qin, { type: 'spam', title: 't' })).status, 400);
  assert.equal((await call('POST', `/ws/${wsB.id}/posts`, a.tokens.Qin, { type: 'note', title: 't', to: ['ghost'] })).status, 400);
  close();
});

test('firestore value encoding round-trips', () => {
  const doc = { s: 'x', n: 3, f: 1.5, b: false, z: null, a: ['p', 2], m: { k: { deep: true } }, e: {} };
  assert.deepEqual(decodeFields(encodeFields(doc)), doc);
});
