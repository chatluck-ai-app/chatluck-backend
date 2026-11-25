import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.ts';
import { openSqlite } from '../src/db.ts';
import { createDocument } from '../src/files.ts';
import type { Provider, ChatMsg, ToolCall } from '../src/providers/types.ts';
process.env.JWT_SECRET ??= 'x'.repeat(40);
const { config } = await import('../src/config.ts'); config.jwtSecret = 'x'.repeat(40);

type Script = (msgs: ChatMsg[]) => { content?: string; toolCalls?: ToolCall[] };
const call = (name: string, args: any, id = 'c' + Math.random()): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
function fakeTelegram(files: Record<string, Buffer> = {}) {
  const calls: { method: string; body: any }[] = []; let mid = 100;
  const fetchImpl = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('/file/bot')) { const k = u.split('/').pop()!; return new Response(files[k] ?? Buffer.from(''), { status: files[k] ? 200 : 404 }); }
    const method = u.split('/').pop()!;
    let body: any = init?.body;
    if (body instanceof FormData) { const doc = body.get('document') as File; body = { chat_id: body.get('chat_id'), docName: doc.name, docBytes: Buffer.from(await doc.arrayBuffer()) }; }
    else body = JSON.parse(body ?? '{}');
    calls.push({ method, body });
    if (method === 'getFile') return Response.json({ ok: true, result: { file_path: String(body.file_id) } });
    return Response.json({ ok: true, result: { message_id: ++mid } });
  }) as typeof fetch;
  return { calls, fetchImpl, sent: () => calls.filter(c => c.method === 'sendMessage').map(c => c.body.text as string) };
}
async function setup(script: Script[], files: Record<string, Buffer> = {}) {
  let i = 0;
  const provider: Provider = { name: 'fake', configured: () => true, listModels: async () => [{ id: 'm1', provider: 'fake', label: 'm1' }], async *chatStream() { yield 'x'; },
    async chat(_m, msgs) { const r = script[i++](msgs); return { content: r.content ?? '', toolCalls: r.toolCalls ?? [] }; },
    async search() { return { answer: 'a', sources: [{ title: 't', url: 'https://example.com' }] }; } };
  const tg = fakeTelegram(files);
  const app = await buildApp({ db: await openSqlite(':memory:'), providers: [provider], telegram: { token: 'TESTTOKEN', pairingCode: 'PAIR-1234', fetchImpl: tg.fetchImpl, sync: true } });
  const t = (app as any).telegram;
  let uid = 1;
  const post = async (update: any, secret = t.secret, header = t.secret) => app.inject({ method: 'POST', url: '/telegram/webhook/' + secret, headers: { 'x-telegram-bot-api-secret-token': header }, payload: { update_id: uid++, ...update } });
  const say = (text: string, from = 42, chat = 42) => post({ message: { message_id: uid + 1000, chat: { id: chat, type: 'private' }, from: { id: from }, text } });
  return { app, tg, post, say, t, db: undefined as any };
}

test('webhook secret is enforced; unpaired users are refused; pairing links one owner only', async () => {
  const { app, tg, post, say } = await setup([]);
  assert.equal((await post({}, 'wrong', 'wrong')).statusCode, 403);
  assert.equal((await post({}, undefined, 'bad')).statusCode, 403);
  await say('hello'); assert.match(tg.sent().at(-1)!, /غير مصرّح/);
  await say('PAIR-1234', 77, 77); assert.match(tg.sent().at(-1)!, /تم الربط/);
  await say('PAIR-1234', 88, 88); assert.match(tg.sent().at(-1)!, /غير مصرّح/); // second person cannot pair
  const before = tg.calls.length; await say('/tasks', 99, 77); assert.equal(tg.calls.length, before); // wrong sender id in the owner's chat is ignored
  await app.close();
});

test('task flow: search tool, final answer, status; /tasks and /task show steps', async () => {
  const { tg, say, app } = await setup([() => ({ toolCalls: [call('web_search', { query: 'x' })] }), () => ({ content: 'النتيجة مع المصدر' })]);
  await say('PAIR-1234'); await say('ابحث عن x');
  const s = tg.sent(); assert.ok(s.some(x => x.includes('بحث على الإنترنت'))); assert.ok(s.includes('النتيجة مع المصدر')); assert.ok(s.at(-1)!.includes('مكتملة'));
  await say('/tasks'); assert.match(tg.sent().at(-1)!, /1\. ✅ ابحث عن x/);
  await say('/task 1'); assert.match(tg.sent().at(-1)!, /tool \/ web_search - ok/);
  await app.close();
});

test('approval via inline buttons: approve saves memory, reject does not', async () => {
  const { tg, say, post, app } = await setup([() => ({ toolCalls: [call('save_memory', { content: 'أحب الإيجاز' }, 'k1')] }), () => ({ content: 'تم' }), () => ({ toolCalls: [call('save_memory', { content: 'شيء آخر' }, 'k2')] }), () => ({ content: 'لم يُحفظ' })]);
  await say('PAIR-1234'); await say('تذكر أني أحب الإيجاز');
  let ap = tg.calls.filter(c => c.method === 'sendMessage' && c.body.reply_markup?.inline_keyboard?.length).at(-1)!;
  assert.match(ap.body.text, /أحتاج موافقتك/); assert.ok(ap.body.text.includes('أحب الإيجاز'));
  await say('/memory'); assert.match(tg.sent().at(-1)!, /لا يوجد شيء محفوظ/);
  const approve = ap.body.reply_markup.inline_keyboard[0][0].callback_data;
  await post({ callback_query: { id: 'q1', from: { id: 42 }, data: approve, message: { message_id: 5, chat: { id: 42 } } } });
  await say('/memory'); assert.match(tg.sent().at(-1)!, /1\. أحب الإيجاز/);
  // stranger cannot press the button
  await say('اذكر شيئاً آخر');
  ap = tg.calls.filter(c => c.method === 'sendMessage' && c.body.reply_markup?.inline_keyboard?.length).at(-1)!;
  const rej = ap.body.reply_markup.inline_keyboard[0][1].callback_data;
  await post({ callback_query: { id: 'q2', from: { id: 999 }, data: rej, message: { message_id: 6, chat: { id: 42 } } } });
  await say('/memory'); assert.ok(!tg.sent().at(-1)!.includes('شيء آخر'));
  await post({ callback_query: { id: 'q3', from: { id: 42 }, data: rej, message: { message_id: 6, chat: { id: 42 } } } });
  await say('/memory'); assert.ok(!tg.sent().at(-1)!.includes('شيء آخر'));
  await say('/forget all'); await say('/memory'); assert.match(tg.sent().at(-1)!, /لا يوجد شيء محفوظ/);
  await app.close();
});

test('files in and out: upload docx, ask to summarise; create xlsx is sent as a document', async () => {
  const d = await createDocument({ type: 'docx', title: 'Contract', sections: [{ heading: 'Terms', body: 'unique-sentinel-77' }] });
  let seenFileText = '';
  const { tg, post, say, app } = await setup([
    () => ({ toolCalls: [call('read_file', { file_id: '__FID__' })] }), // replaced below
  ], { 'F1': d.buf });
  await say('PAIR-1234');
  await post({ message: { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 42 }, document: { file_id: 'F1', file_name: 'contract.docx', file_size: d.buf.length } } });
  assert.match(tg.sent().at(-1)!, /استلمت contract.docx/);
  await post({ message: { message_id: 8, chat: { id: 42, type: 'private' }, from: { id: 42 }, document: { file_id: 'NOPE', file_name: 'x.exe' } } });
  assert.match(tg.sent().at(-1)!, /غير مدعوم/);
  await app.close();
  // second app: scripted flow that reads the uploaded file id from the goal and creates an xlsx
  const s2 = await setup([
    (m) => { const goal = String((m[1] as any).content); const id = /file_id: ([0-9a-f-]+)/.exec(goal)![1]; return { toolCalls: [call('read_file', { file_id: id })] }; },
    (m) => { seenFileText = String((m.at(-1) as any).content); return { toolCalls: [call('create_document', { type: 'xlsx', title: 'Summary', sheets: [{ name: 'S', rows: [['k', 'v'], ['clause', 'Terms']] }] })] }; },
    () => ({ content: 'لخّصت وأنشأت الملف' }),
  ], { 'F1': d.buf });
  await s2.say('PAIR-1234');
  await s2.post({ message: { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 42 }, document: { file_id: 'F1', file_name: 'contract.docx', file_size: d.buf.length } } });
  await s2.say('لخص العقد في جدول');
  assert.ok(seenFileText.includes('unique-sentinel-77'));
  const doc = s2.tg.calls.find(c => c.method === 'sendDocument')!; assert.ok(doc, 'document sent'); assert.equal(doc.body.docName, 'Summary.xlsx'); assert.equal(doc.body.docBytes.subarray(0, 2).toString(), 'PK');
  assert.ok(s2.tg.sent().some(x => x.includes('تحقق')));
  await s2.app.close();
});

test('reminders: created via tool, delivered when due, late label; voice is refused honestly', async () => {
  const soon = new Date(Date.now() + 3600_000); const p = (n: number) => String(n).padStart(2, '0');
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }).format(soon);
  const { tg, say, post, app, t } = await setup([() => ({ toolCalls: [call('create_reminder', { text: 'اتصل بأحمد', when: local })] }), () => ({ content: 'ضبطت التذكير' })]);
  await say('PAIR-1234'); await say('ذكرني بعد ساعة');
  await say('/reminders'); assert.ok(tg.sent().at(-1)!.includes('اتصل بأحمد'));
  assert.equal(await t.deliverDue(), 0);
  const realNow = Date.now; Date.now = () => realNow() + 2 * 3600_000;
  try { assert.equal(await t.deliverDue(), 1); } finally { Date.now = realNow; }
  assert.ok(tg.sent().at(-1)!.includes('⏰ تذكير: اتصل بأحمد')); assert.match(tg.sent().at(-1)!, /متأخراً/);
  assert.equal(await t.deliverDue(), 0); // not delivered twice
  await post({ message: { message_id: 9, chat: { id: 42, type: 'private' }, from: { id: 42 }, voice: { file_id: 'v' } } });
  assert.match(tg.sent().at(-1)!, /اكتبلي الطلب نص/);
  await app.close();
});

test('duplicate update ids are processed once; group chats ignored', async () => {
  const { tg, app, t } = await setup([]);
  const upd = { update_id: 5000, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'hi' } };
  for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: t.webhookPath, headers: { 'x-telegram-bot-api-secret-token': t.secret }, payload: upd });
  assert.equal(tg.sent().length, 1);
  await app.inject({ method: 'POST', url: t.webhookPath, headers: { 'x-telegram-bot-api-secret-token': t.secret }, payload: { update_id: 5001, message: { message_id: 2, chat: { id: -9, type: 'group' }, from: { id: 42 }, text: 'PAIR-1234' } } });
  assert.equal(tg.sent().length, 1);
  await app.close();
});
