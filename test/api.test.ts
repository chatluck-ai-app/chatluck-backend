import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.ts';
import { openSqlite, pgFromPool } from '../src/db.ts';
import { newDb } from 'pg-mem';
import type { Provider } from '../src/providers/types.ts';
process.env.JWT_SECRET ??= 'x'.repeat(40);
const { config } = await import('../src/config.ts'); config.jwtSecret = 'x'.repeat(40);

// Test-only fake provider (not a claim that real providers work).
const fake: Provider = { name: 'fake', configured: () => true,
  listModels: async () => [{ id: 'm1', provider: 'fake', label: 'm1' }],
  async *chatStream(_m, msgs) { const last = msgs[msgs.length - 1].content; for (const w of ['echo:', ' ', last]) yield w; } };
let kind = 'sqlite';
const mk = async () => {
  if (kind === 'sqlite') return buildApp({ db: await openSqlite(':memory:'), providers: [fake] });
  const mem = newDb(); const { Pool } = mem.adapters.createPg();
  return buildApp({ db: await pgFromPool(new Pool()), providers: [fake] });
};
const j = (r: any) => r.json();
async function reg(app: any, email = 'a@b.co') {
  return j(await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'password123' } }));
}
const H = (t: string) => ({ authorization: 'Bearer ' + t });

for (const k of ['sqlite', 'pg']) test(k + ': ' + 'register/login/guest/auth required', async () => {
  kind = k;
  const app = await mk(); const r = await reg(app);
  assert.ok(r.token);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'a@b.co', password: 'password123' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@b.co', password: 'wrong' } })).statusCode, 401);
  assert.ok(j(await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@b.co', password: 'password123' } })).token);
  assert.ok(j(await app.inject({ method: 'POST', url: '/v1/auth/guest' })).token);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: H('bad.token') })).statusCode, 401);
});

for (const k of ['sqlite', 'pg']) test(k + ': ' + 'chat stream, persistence, regenerate, edit, search, archive, delete', async () => {
  kind = k;
  const app = await mk(); const { token } = await reg(app);
  const { id } = j(await app.inject({ method: 'POST', url: '/v1/conversations', headers: H(token), payload: {} }));
  const send = (payload: any) => app.inject({ method: 'POST', url: `/v1/conversations/${id}/messages`, headers: H(token), payload });
  let r = await send({ content: 'hello', model: 'fake:m1' });
  assert.match(r.body, /event: delta/); assert.match(r.body, /event: done/);
  let c = j(await app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: H(token) }));
  assert.deepEqual(c.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(c.messages[1].content, 'echo: hello');
  assert.equal(c.conversation.title, 'hello');
  await send({ regenerate: true, model: 'fake:m1' });
  c = j(await app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: H(token) }));
  assert.equal(c.messages.length, 2);
  await send({ content: 'edited', editMessageId: c.messages[0].id, model: 'fake:m1' });
  c = j(await app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: H(token) }));
  assert.deepEqual(c.messages.map((m: any) => m.content), ['edited', 'echo: edited']);
  assert.equal(j(await app.inject({ method: 'GET', url: '/v1/conversations?q=edited', headers: H(token) })).conversations.length, 1);
  await app.inject({ method: 'PATCH', url: `/v1/conversations/${id}`, headers: H(token), payload: { archived: true, title: 'T' } });
  assert.equal(j(await app.inject({ method: 'GET', url: '/v1/conversations', headers: H(token) })).conversations.length, 0);
  assert.equal(j(await app.inject({ method: 'GET', url: '/v1/conversations?archived=1', headers: H(token) })).conversations[0].title, 'T');
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/conversations/${id}`, headers: H(token) })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: H(token) })).statusCode, 404);
});

for (const k of ['sqlite', 'pg']) test(k + ': ' + 'model validation, isolation between users, quota, admin guard', async () => {
  kind = k;
  const app = await mk(); const a = await reg(app, 'a@b.co'); const b = await reg(app, 'c@d.co');
  const { id } = j(await app.inject({ method: 'POST', url: '/v1/conversations', headers: H(a.token), payload: {} }));
  const url = `/v1/conversations/${id}/messages`;
  assert.equal((await app.inject({ method: 'POST', url, headers: H(a.token), payload: { content: 'x', model: 'openai:gpt' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: H(b.token), payload: { content: 'x', model: 'fake:m1' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/conversations/${id}`, headers: H(b.token) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: H(a.token) })).statusCode, 403);
  const g = j(await app.inject({ method: 'POST', url: '/v1/auth/guest' }));
  const gc = j(await app.inject({ method: 'POST', url: '/v1/conversations', headers: H(g.token), payload: {} })).id;
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await app.inject({ method: 'POST', url: `/v1/conversations/${gc}/messages`, headers: H(g.token), payload: { content: 'x', model: 'fake:m1' } })).statusCode;
  assert.equal(last, 429);
  assert.equal(j(await app.inject({ method: 'GET', url: '/v1/me', headers: H(g.token) })).usage.messagesToday, 10);
});

for (const k of ['sqlite', 'pg']) test(k + ': ' + 'assistants and models list', async () => {
  kind = k;
  const app = await mk(); const { token } = await reg(app);
  assert.ok(j(await app.inject({ method: 'GET', url: '/v1/assistants', headers: H(token) })).assistants.length >= 5);
  assert.equal(j(await app.inject({ method: 'GET', url: '/v1/models', headers: H(token) })).models[0].id, 'm1');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/assistants', headers: H(token), payload: { name: 'Mine', instructions: 'Be brief' } })).statusCode, 200);
});
