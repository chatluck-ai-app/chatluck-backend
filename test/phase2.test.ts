import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.ts';
import { openSqlite } from '../src/db.ts';
import { secretReason } from '../src/memory.ts';
import { assertPublicUrl, htmlToText } from '../src/tools/index.ts';
import type { Provider, ChatMsg, ToolCall } from '../src/providers/types.ts';
process.env.JWT_SECRET ??= 'x'.repeat(40);
const { config } = await import('../src/config.ts'); config.jwtSecret = 'x'.repeat(40);

/** Scripted provider: each chat() call pops the next scripted reply (test double, not a real model). */
function scripted(script: ((msgs: ChatMsg[]) => { content?: string; toolCalls?: ToolCall[] })[]): Provider {
  let i = 0;
  return { name: 'fake', configured: () => true, listModels: async () => [{ id: 'm1', provider: 'fake', label: 'm1' }],
    async *chatStream() { yield 'x'; },
    async chat(_m, msgs) { const r = script[i++](msgs); return { content: r.content ?? '', toolCalls: r.toolCalls ?? [] }; },
    async search(q) { return { answer: 'answer for ' + q, sources: [{ title: 'Example', url: 'https://example.com/a' }] }; } };
}
const call = (name: string, args: any, id = 'c' + Math.random()): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const H = (t: string) => ({ authorization: 'Bearer ' + t });
async function setup(script: any[]) {
  const app = await buildApp({ db: await openSqlite(':memory:'), providers: [scripted(script)] });
  const { token } = (await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'a@b.co', password: 'password123' } })).json();
  return { app, token };
}
const events = (body: string) => body.split('\n\n').filter(Boolean).map(b => { const [e, d] = b.split('\n'); return { ev: e.slice(7), data: JSON.parse(d.slice(6)) }; });
async function run(app: any, token: string, payload: any) { const r = await app.inject({ method: 'POST', url: '/v1/agent/run', headers: H(token), payload: { model: 'fake:m1', ...payload } }); return { status: r.statusCode, evs: r.statusCode === 200 ? events(r.body) : [], raw: r }; }

test('agent: search tool then final answer, steps logged', async () => {
  const { app, token } = await setup([() => ({ toolCalls: [call('web_search', { query: 'q1' })] }), (m) => { assert.ok(JSON.stringify(m).includes('example.com')); return { content: 'done with source' }; }]);
  const { evs } = await run(app, token, { goal: 'find q1' });
  assert.equal(evs.at(-1)!.data.status, 'completed');
  const id = evs.find(e => e.ev === 'task')!.data.id;
  const t = (await app.inject({ method: 'GET', url: '/v1/tasks/' + id, headers: H(token) })).json();
  assert.equal(t.task.status, 'completed'); assert.equal(t.task.result, 'done with source');
  assert.deepEqual(t.steps.map((s: any) => s.kind + ':' + (s.tool ?? '')), ['model:', 'tool:web_search', 'final:']);
  const conv = (await app.inject({ method: 'GET', url: '/v1/conversations/' + evs[0].data.conversationId, headers: H(token) })).json();
  assert.deepEqual(conv.messages.map((m: any) => m.role), ['user', 'assistant']);
});

test('agent: create_document is verified by reopening; file downloadable', async () => {
  const { app, token } = await setup([() => ({ toolCalls: [call('create_document', { type: 'docx', title: 'تقرير', sections: [{ heading: 'ملخص', body: 'نص' }] })] }), () => ({ content: 'ok' })]);
  const { evs } = await run(app, token, { goal: 'make doc', agent: 'files' });
  assert.equal(evs.at(-1)!.data.status, 'completed');
  assert.ok(evs.some(e => e.ev === 'file')); assert.ok(evs.some(e => e.ev === 'step' && e.data.kind === 'verify' && e.data.status === 'ok'));
  const f = evs.find(e => e.ev === 'file')!.data;
  const d = await app.inject({ method: 'GET', url: `/v1/files/${f.fileId}/download`, headers: H(token) });
  assert.equal(d.statusCode, 200); assert.equal(d.rawPayload.subarray(0, 2).toString(), 'PK');
});

test('agent: failing tool is reported, task ends partially_completed (no fake success)', async () => {
  const { app, token } = await setup([() => ({ toolCalls: [call('web_read', { url: 'http://127.0.0.1/secret' })] }), () => ({ content: 'could not read' })]);
  const { evs } = await run(app, token, { goal: 'read it' });
  assert.equal(evs.at(-1)!.data.status, 'partially_completed');
  assert.ok(evs.some(e => e.ev === 'step' && e.data.status === 'failed'));
});

test('agent: approval gate for save_memory; approve resumes, reject does not save', async () => {
  const { app, token } = await setup([() => ({ toolCalls: [call('save_memory', { content: 'أفضّل الردود المختصرة' }, 'k1')] }), () => ({ content: 'saved' }),
    () => ({ toolCalls: [call('save_memory', { content: 'x pref' }, 'k2')] }), () => ({ content: 'ok not saved' })]);
  let r = await run(app, token, { goal: 'remember' });
  assert.equal(r.evs.at(-1)!.data.status, 'waiting_approval');
  const ap = r.evs.find(e => e.ev === 'approval')!.data;
  assert.equal((await app.inject({ method: 'GET', url: '/v1/memory', headers: H(token) })).json().items.length, 0);
  const res = await app.inject({ method: 'POST', url: `/v1/tasks/${ap.taskId}/approve`, headers: H(token), payload: { callId: ap.callId, approve: true } });
  assert.equal(events(res.body).at(-1)!.data.status, 'completed');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/memory', headers: H(token) })).json().items.length, 1);
  r = await run(app, token, { goal: 'remember 2' });
  const ap2 = r.evs.find(e => e.ev === 'approval')!.data;
  const res2 = await app.inject({ method: 'POST', url: `/v1/tasks/${ap2.taskId}/approve`, headers: H(token), payload: { callId: ap2.callId, approve: false } });
  assert.equal(events(res2.body).at(-1)!.data.status, 'completed');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/memory', headers: H(token) })).json().items.length, 1);
});

test('cancel a waiting task; unknown agent and tool restrictions', async () => {
  const { app, token } = await setup([() => ({ toolCalls: [call('save_memory', { content: 'abc' }, 'k')] }), () => ({ toolCalls: [call('web_search', { query: 'x' })] }), () => ({ content: 'r' })]);
  const r = await run(app, token, { goal: 'g' }); const ap = r.evs.find(e => e.ev === 'approval')!.data;
  assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${ap.taskId}/cancel`, headers: H(token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/tasks/${ap.taskId}/cancel`, headers: H(token) })).statusCode, 409);
  assert.equal((await run(app, token, { goal: 'g', agent: 'nope' })).status, 400);
  // research agent has no save_memory tool
  const { app: a2, token: t2 } = await setup([() => ({ toolCalls: [call('save_memory', { content: 'abc' })] }), () => ({ content: 'r' })]);
  const rr = await run(a2, t2, { goal: 'g', agent: 'research' });
  assert.equal(rr.evs.at(-1)!.data.status, 'partially_completed');
});

test('memory: secrets rejected, CRUD, disable', async () => {
  const { app, token } = await setup([]);
  for (const bad of ['كلمة المرور بتاعتي 1234', 'my password is abc', 'card 4111 1111 1111 1111', 'api key AIzaSyA1234567890123456789012', 'الرقم السري ١٢٣٤'])
    assert.equal((await app.inject({ method: 'POST', url: '/v1/memory', headers: H(token), payload: { content: bad } })).statusCode, 400, bad);
  assert.equal(secretReason('أحب القهوة'), null);
  const ok = (await app.inject({ method: 'POST', url: '/v1/memory', headers: H(token), payload: { content: 'أحب القهوة' } })).json();
  assert.equal((await app.inject({ method: 'GET', url: '/v1/memory', headers: H(token) })).json().items.length, 1);
  await app.inject({ method: 'PATCH', url: '/v1/memory/settings', headers: H(token), payload: { enabled: false } });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/memory', headers: H(token), payload: { content: 'x y' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/memory/' + ok.id, headers: H(token) })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/memory', headers: H(token) })).json().items.length, 0);
});

test('files: upload docx/xlsx/pptx/txt, read via agent; bad types and size rejected', async () => {
  const { createDocument } = await import('../src/files.ts');
  const { app, token } = await setup([]);
  const specs: any[] = [{ type: 'docx', title: 'Hello', sections: [{ heading: 'H1', body: 'unique-docx-body' }] }, { type: 'xlsx', title: 'T', sheets: [{ name: 'S', rows: [['a', 'b'], ['unique-xlsx', 5]] }] }, { type: 'pptx', title: 'Deck', sections: [{ heading: 'Slide', body: 'unique-pptx' }] }, { type: 'pdf', title: 'P', sections: [{ heading: 'H', body: 'unique-pdf' }] }];
  for (const sp of specs) {
    const d = await createDocument(sp);
    const up = (await app.inject({ method: 'POST', url: '/v1/files', headers: H(token), payload: { name: d.name, dataBase64: d.buf.toString('base64') } })).json();
    assert.ok(up.id, JSON.stringify(up)); assert.ok(up.chars > 0, sp.type);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/files', headers: H(token), payload: { name: 'a.exe', dataBase64: 'AAAA' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/files', headers: H(token), payload: { name: 'a.pdf', dataBase64: Buffer.from('not a pdf').toString('base64') } })).statusCode, 400);
  const list = (await app.inject({ method: 'GET', url: '/v1/files', headers: H(token) })).json().files; assert.equal(list.length, 4);
  const { app: a2, token: t2 } = await setup([]); // other user cannot see files
  assert.equal((await a2.inject({ method: 'GET', url: `/v1/files/${list[0].id}/download`, headers: H(t2) })).statusCode, 404);
});

test('security: SSRF guard and html extraction', async () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://[::1]/', 'file:///etc/passwd'])
    await assert.rejects(assertPublicUrl(u), undefined, u);
  assert.ok((await assertPublicUrl('https://example.com/')).hostname);
  assert.equal(htmlToText('<script>x</script><p>مرحبا &amp; hi</p>'), 'مرحبا & hi');
});

test('agent: model call limit stops runaway loops', async () => {
  const loop = Array.from({ length: 10 }, () => () => ({ toolCalls: [call('web_search', { query: 'again' })] }));
  const { app, token } = await setup(loop);
  const { evs } = await run(app, token, { goal: 'loop' });
  assert.equal(evs.at(-1)!.data.status, 'failed');
});
