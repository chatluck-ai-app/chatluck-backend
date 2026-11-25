import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import type { Service } from './phase2.ts';
import { AGENTS, TZ } from './tools/index.ts';
import { addMemory, MemoryError, memoryEnabled } from './memory.ts';
import { extOf, isImage, MIME } from './files.ts';

export interface TgOptions { token: string; pairingCode: string; apiBase?: string; fetchImpl?: typeof fetch; sync?: boolean; allowMore?: boolean }
const STATUS_ICON: Record<string, string> = { completed: '✅', failed: '❌', partially_completed: '⚠️', waiting_approval: '⏳', canceled: '🚫', running: '🔄', pending: '🕓' };
const STATUS_AR: Record<string, string> = { completed: 'مكتملة', failed: 'فشلت', partially_completed: 'مكتملة جزئياً', waiting_approval: 'بانتظار موافقتك', canceled: 'ملغاة', running: 'قيد التنفيذ', pending: 'في الانتظار' };
const HELP = `أنا Chat Luck. اكتب لي أي طلب وأنفّذه بالأدوات المتاحة فعلاً: بحث على الإنترنت بمصادر، قراءة الملفات اللي ترسلها (PDF وWord وExcel وPowerPoint وصور)، إنشاء ملفات DOCX/XLSX/PPTX/PDF، تذكيرات، وذاكرة تتحكم فيها.

الأوامر:
/tasks آخر المهام
/task <رقم> تفاصيل خطوات مهمة
/cancel <رقم> إلغاء مهمة
/files ملفاتك
/memory ما أتذكره عنك، /forget <رقم> أو /forget all
/memory_off و /memory_on
/reminders تذكيراتك
/agent general|research|files|tasks اختيار الوكيل (الحالي: general)
/status حالة الخدمة

ملاحظات: التذكيرات تعتمد على أن السيرفر المجاني صاحي، فقد تصل متأخرة. الرسائل الصوتية غير مدعومة بعد. لا أنفّذ مدفوعات ولا أرسل رسائل باسمك.`;

export function registerTelegram(app: FastifyInstance, db: Db, svc: Service, opt: TgOptions) {
  const base = (opt.apiBase ?? 'https://api.telegram.org') + '/bot' + opt.token;
  const fileBase = (opt.apiBase ?? 'https://api.telegram.org') + '/file/bot' + opt.token;
  const f = opt.fetchImpl ?? fetch;
  const secret = createHash('sha256').update('wh:' + opt.token).digest('hex').slice(0, 32);
  const api = async (method: string, body: any = {}) => {
    const r = await f(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({})); if (!j.ok) app.log.warn({ method, desc: j.description }, 'telegram api error'); return j;
  };
  const send = async (chat: string, text: string, extra: any = {}) => {
    let last: any; const t = text || '…';
    for (let i = 0; i < t.length; i += 4000) last = await api('sendMessage', { chat_id: chat, text: t.slice(i, i + 4000), ...(i + 4000 >= t.length ? extra : {}) });
    return last;
  };
  const sendFile = async (chat: string, name: string, mime: string, data: Buffer, caption?: string) => {
    const fd = new FormData(); fd.append('chat_id', chat); if (caption) fd.append('caption', caption.slice(0, 900));
    fd.append('document', new Blob([data], { type: mime }), name);
    const r = await f(`${base}/sendDocument`, { method: 'POST', body: fd }); const j: any = await r.json().catch(() => ({})); if (!j.ok) app.log.warn({ desc: j.description }, 'sendDocument failed'); return j.ok;
  };
  const downloadFile = async (fileId: string) => {
    const j: any = await api('getFile', { file_id: fileId }); if (!j.ok || !j.result?.file_path) throw new Error(j.description ?? 'getFile failed');
    const r = await f(`${fileBase}/${j.result.file_path}`); if (!r.ok) throw new Error('download failed'); return Buffer.from(await r.arrayBuffer());
  };
  const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const chains = new Map<string, Promise<unknown>>();
  const serial = (chat: string, fn: () => Promise<unknown>) => { const p = (chains.get(chat) ?? Promise.resolve()).then(fn).catch(e => app.log.error({ err: String(e?.message) }, 'tg handler')); chains.set(chat, p); return p; };
  const pending = new Set<Promise<unknown>>();

  async function linkOf(chat: string) { return (await db.get('SELECT * FROM tg_links WHERE chat_id=?', chat)) as any; }
  const shortId = (id: string) => id.slice(0, 6);
  async function findTask(userId: string, ref: string) {
    const rows = await db.all('SELECT id FROM tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 50', userId) as any[];
    if (/^\d+$/.test(ref)) return rows[Number(ref) - 1]?.id as string | undefined;
    return rows.find(r => r.id.startsWith(ref))?.id as string | undefined;
  }
  const describeArgs = (tool: string, a: any) => tool === 'save_memory' ? `حفظ في الذاكرة: «${a.content}»` : `${tool}: ${JSON.stringify(a).slice(0, 300)}`;

  /** Runs a task and presents events as Telegram messages. */
  async function present(chat: string, user: { id: string; plan: string }, runner: (emit: (e: string, d: any) => void) => Promise<any>) {
    const lines: string[] = []; let statusMsg: number | null = null; let finalText = ''; let doneStatus = ''; let taskId = '';
    const files: string[] = []; const approvals: any[] = []; let err = '';
    const typing = setInterval(() => void api('sendChatAction', { chat_id: chat, action: 'typing' }), 4000); void api('sendChatAction', { chat_id: chat, action: 'typing' });
    const stepNames: Record<string, string> = { web_search: 'بحث على الإنترنت', web_read: 'قراءة صفحة', read_file: 'قراءة ملف', create_document: 'إنشاء ملف', save_memory: 'حفظ في الذاكرة', create_reminder: 'إنشاء تذكير', list_reminders: 'عرض التذكيرات', cancel_reminder: 'إلغاء تذكير' };
    const evs: [string, any][] = [];
    try { await runner((e, d) => evs.push([e, d])); } finally { clearInterval(typing); }
    for (const [e, d] of evs) {
      if (e === 'task') taskId = d.id;
      else if (e === 'step' && d.kind === 'tool') lines.push(`${d.status === 'ok' ? '✔️' : '✖️'} ${stepNames[d.tool] ?? d.tool}${d.status === 'failed' ? ': ' + String(d.preview).slice(0, 120) : ''}`);
      else if (e === 'step' && d.kind === 'verify') lines.push(`${d.status === 'ok' ? '🔎' : '⚠️'} تحقق: ${String(d.preview).slice(0, 120)}`);
      else if (e === 'file') files.push(d.fileId);
      else if (e === 'approval') approvals.push(d);
      else if (e === 'delta') finalText += d.t;
      else if (e === 'error') err = d.message;
      else if (e === 'done') doneStatus = d.status;
    }
    if (lines.length) statusMsg = (await send(chat, 'خطوات التنفيذ:\n' + lines.join('\n')))?.result?.message_id ?? null;
    for (const fid of files) { const fr: any = await db.get('SELECT name,mime,data FROM files WHERE id=? AND user_id=?', fid, user.id); if (fr) await sendFile(chat, fr.name, fr.mime, Buffer.from(fr.data, 'base64')); }
    if (finalText) await send(chat, finalText);
    if (err) await send(chat, '❌ ' + err);
    for (const ap of approvals) {
      const token = randomBytes(6).toString('hex');
      await db.run('INSERT INTO tg_approvals(token,task_id,call_id,chat_id,user_id) VALUES(?,?,?,?,?)', token, ap.taskId, ap.callId, chat, user.id);
      await send(chat, `⏳ أحتاج موافقتك:\n${describeArgs(ap.tool, ap.args)}`, { reply_markup: { inline_keyboard: [[{ text: '✅ موافق', callback_data: `a:${token}:1` }, { text: '❌ رفض', callback_data: `a:${token}:0` }]] } });
    }
    if (taskId) { const n = (await db.all('SELECT id FROM tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 50', user.id) as any[]).findIndex(r => r.id === taskId) + 1; await send(chat, `${STATUS_ICON[doneStatus] ?? ''} المهمة #${n} (${shortId(taskId)}): ${STATUS_AR[doneStatus] ?? doneStatus}`); }
  }

  async function runGoal(chat: string, link: any, goal: string, fileIds: string[]) {
    const user = { id: link.user_id, plan: 'owner' };
    await present(chat, user, async (emit) => {
      const ac = new AbortController();
      const r = await svc.start(user, { goal, agent: (link.agent && link.agent !== 'general') ? link.agent : (/(android studio|source code|مشروع برمج|مشروع اندرويد|مشروع أندرويد|كود كامل|الكود المصدري|ملفات برمجية|برمجي)/i.test(goal) ? 'dev' : 'general'), fileIds }, emit, ac.signal);
      if ('error' in r) { emit('error', { message: r.message }); return; }
      await r.run();
    });
  }

  async function handleCommand(chat: string, link: any, text: string) {
    const [cmd, ...rest] = text.trim().split(/\s+/); const arg = rest.join(' ');
    const c = cmd.toLowerCase().replace(/@\w+$/, '');
    if (c === '/start' || c === '/help') return send(chat, HELP);
    if (c === '/tasks') {
      const rows = await db.all('SELECT id,title,status FROM tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 10', link.user_id) as any[];
      return send(chat, rows.length ? rows.map((r, i) => `${i + 1}. ${STATUS_ICON[r.status] ?? ''} ${r.title} (${shortId(r.id)})`).join('\n') : 'لا توجد مهام بعد.');
    }
    if (c === '/task') {
      const id = await findTask(link.user_id, arg); if (!id) return send(chat, 'لم أجد هذه المهمة. استخدم /tasks.');
      const t: any = await db.get('SELECT title,status,result,error FROM tasks WHERE id=?', id);
      const steps = await db.all('SELECT idx,kind,tool,status,error FROM task_steps WHERE task_id=? ORDER BY idx', id) as any[];
      return send(chat, `${STATUS_ICON[t.status] ?? ''} ${t.title}\nالحالة: ${STATUS_AR[t.status] ?? t.status}\n\nالخطوات:\n` + (steps.map(s => `${s.idx}. ${s.kind}${s.tool ? ' / ' + s.tool : ''} - ${s.status}${s.error ? ' (' + s.error.slice(0, 80) + ')' : ''}`).join('\n') || 'لا توجد خطوات') + (t.error ? '\nالخطأ: ' + t.error : ''));
    }
    if (c === '/cancel') {
      const id = await findTask(link.user_id, arg); if (!id) return send(chat, 'لم أجد هذه المهمة. استخدم /tasks.');
      const t: any = await db.get('SELECT status FROM tasks WHERE id=?', id);
      if (['completed', 'failed', 'partially_completed', 'canceled'].includes(t.status)) return send(chat, 'المهمة انتهت بالفعل.');
      await db.run("UPDATE tasks SET status='canceled', updated_at=? WHERE id=?", Date.now(), id); return send(chat, '🚫 تم إلغاء المهمة.');
    }
    if (c === '/files') {
      const rows = await db.all('SELECT id,name,size,origin FROM files WHERE user_id=? ORDER BY created_at DESC LIMIT 15', link.user_id) as any[];
      return send(chat, rows.length ? rows.map((r, i) => `${i + 1}. ${r.name} (${Math.ceil(r.size / 1024)} كيلوبايت، ${r.origin === 'upload' ? 'مرفوع' : 'أنشأته أنا'})`).join('\n') + '\n\nلإرسال ملف: /getfile <رقم>' : 'لا توجد ملفات.');
    }
    if (c === '/getfile') {
      const rows = await db.all('SELECT id,name,mime,data FROM files WHERE user_id=? ORDER BY created_at DESC LIMIT 15', link.user_id) as any[]; const r = rows[Number(arg) - 1];
      if (!r) return send(chat, 'رقم غير صحيح. استخدم /files.'); await sendFile(chat, r.name, r.mime, Buffer.from(r.data, 'base64')); return;
    }
    if (c === '/memory') {
      const rows = await db.all('SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC', link.user_id) as any[];
      return send(chat, `الذاكرة: ${(await memoryEnabled(db, link.user_id)) ? 'مفعّلة' : 'متوقفة'}\n` + (rows.length ? rows.map((r, i) => `${i + 1}. ${r.content}`).join('\n') : 'لا يوجد شيء محفوظ.') + '\n\nللحذف: /forget <رقم> أو /forget all');
    }
    if (c === '/forget') {
      if (arg === 'all') { await db.run('DELETE FROM memories WHERE user_id=?', link.user_id); return send(chat, 'تم حذف كل الذاكرة.'); }
      const rows = await db.all('SELECT id FROM memories WHERE user_id=? ORDER BY created_at DESC', link.user_id) as any[]; const r = rows[Number(arg) - 1];
      if (!r) return send(chat, 'رقم غير صحيح. استخدم /memory.'); await db.run('DELETE FROM memories WHERE id=?', r.id); return send(chat, 'تم الحذف.');
    }
    if (c === '/memory_on' || c === '/memory_off') {
      await db.run('INSERT INTO user_settings(user_id,memory_enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET memory_enabled=excluded.memory_enabled', link.user_id, c === '/memory_on' ? 1 : 0);
      return send(chat, c === '/memory_on' ? 'الذاكرة مفعّلة.' : 'الذاكرة متوقفة. لن أحفظ ولن أستخدم ما تم حفظه.');
    }
    if (c === '/reminders') {
      const rows = await db.all("SELECT text,due_at FROM reminders WHERE user_id=? AND status='pending' ORDER BY due_at", link.user_id) as any[];
      const fmt = (t: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ(), dateStyle: 'short', timeStyle: 'short' }).format(new Date(t));
      return send(chat, rows.length ? rows.map((r, i) => `${i + 1}. ${fmt(Number(r.due_at))} - ${r.text}`).join('\n') + '\n\n(التسليم قد يتأخر إذا كان السيرفر المجاني نائماً)' : 'لا توجد تذكيرات.');
    }
    if (c === '/agent') {
      if (!AGENTS[arg]) return send(chat, 'الوكلاء: ' + Object.values(AGENTS).map(a => `${a.id} (${a.name})`).join('، '));
      await db.run('UPDATE tg_links SET agent=? WHERE chat_id=?', arg, chat); return send(chat, `تم اختيار: ${AGENTS[arg].name}`);
    }
    if (c === '/status') {
      const models = await svc.defaultModel();
      return send(chat, `الخدمة تعمل.\nالنموذج: ${models ?? 'غير متاح حالياً'}\nالمنطقة الزمنية: ${TZ()}`);
    }
    return send(chat, 'أمر غير معروف. اكتب /help.');
  }

  async function handleUpdate(u: any) {
    if (typeof u.update_id === 'number') {
      const seen = await db.get('SELECT 1 x FROM tg_seen WHERE update_id=?', u.update_id); if (seen) return;
      await db.run('INSERT INTO tg_seen(update_id,at) VALUES(?,?)', u.update_id, Date.now());
    }
    const cq = u.callback_query;
    if (cq) {
      const chat = String(cq.message?.chat?.id ?? ''); const link = await linkOf(chat);
      if (!link || String(cq.from?.id) !== String(link.tg_user_id)) return void api('answerCallbackQuery', { callback_query_id: cq.id, text: 'غير مصرّح' });
      const m = /^a:([0-9a-f]+):([01])$/.exec(cq.data ?? ''); if (!m) return void api('answerCallbackQuery', { callback_query_id: cq.id });
      const ap: any = await db.get('SELECT * FROM tg_approvals WHERE token=? AND chat_id=?', m[1], chat);
      await api('answerCallbackQuery', { callback_query_id: cq.id });
      if (!ap) return void send(chat, 'انتهت صلاحية هذا الطلب.');
      await db.run('DELETE FROM tg_approvals WHERE token=?', m[1]);
      await api('editMessageReplyMarkup', { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      await send(chat, m[2] === '1' ? '✅ تمت الموافقة.' : '❌ تم الرفض.');
      const user = { id: link.user_id, plan: 'owner' };
      return present(chat, user, async (emit) => {
        const r = await svc.resume(user, ap.task_id, ap.call_id, m[2] === '1', emit, new AbortController().signal);
        if ('error' in r) { emit('error', { message: 'تعذر المتابعة: ' + r.error }); return; } await r.run();
      });
    }
    const msg = u.message; if (!msg?.chat) return;
    const chat = String(msg.chat.id); const text: string = msg.text ?? msg.caption ?? '';
    if (msg.chat.type !== 'private') return; // private chats only
    let link = await linkOf(chat);
    if (!link) {
      const taken: any = await db.get('SELECT count(*) c FROM tg_links');
      if (text.trim() && eq(text.trim(), opt.pairingCode) && (Number(taken.c) === 0 || opt.allowMore)) {
        const uid = randomUUID(); await db.run('INSERT INTO users(id,is_guest,plan,created_at) VALUES(?,0,?,?)', uid, 'owner', Date.now());
        await db.run('INSERT INTO tg_links(chat_id,user_id,tg_user_id,agent,created_at) VALUES(?,?,?,?,?)', chat, uid, String(msg.from?.id ?? ''), 'general', Date.now());
        void api('deleteMessage', { chat_id: chat, message_id: msg.message_id });
        return void send(chat, 'تم الربط ✅ أنت الآن المستخدم الوحيد المصرّح له.\n\n' + HELP);
      }
      return void send(chat, text.trim().startsWith('/start') ? 'أهلاً. هذا بوت خاص. أرسل رمز الربط للبدء.' : 'غير مصرّح. أرسل رمز الربط.');
    }
    if (String(msg.from?.id) !== String(link.tg_user_id)) return;
    // files
    const doc = msg.document ?? (msg.photo ? { file_id: msg.photo[msg.photo.length - 1].file_id, file_name: `photo_${msg.message_id}.jpg`, file_size: msg.photo[msg.photo.length - 1].file_size } : null);
    if (msg.voice || msg.audio || msg.video || msg.video_note) return void send(chat, 'الرسائل الصوتية والفيديو غير مدعومة بعد. أرسل نصاً أو ملفاً.');
    const fileIds: string[] = [];
    if (doc) {
      const name: string = doc.file_name ?? `file_${msg.message_id}`;
      if (!MIME[extOf(name)]) return void send(chat, `نوع الملف غير مدعوم (${extOf(name) || 'بدون امتداد'}). المدعوم: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, PNG, JPG, WEBP.`);
      if ((doc.file_size ?? 0) > 10 * 1024 * 1024) return void send(chat, 'الملف أكبر من 10 ميجا.');
      try { const buf = await downloadFile(doc.file_id); const st = await svc.storeFile({ id: link.user_id, plan: 'owner' }, name, buf); fileIds.push(st.id);
        if (!text.trim()) return void send(chat, `استلمت ${name} ✅${st.chars != null ? ` (${st.chars} حرف نصي)` : ' (صورة)'}.\nاكتب لي ماذا تريد أن أفعل به (تلخيص، استخراج، تحويل...).`); }
      catch (e: any) { return void send(chat, '❌ ' + (e.message ?? 'تعذر استلام الملف')); }
    }
    if (!text.trim()) return;
    if (text.startsWith('/')) return void (await handleCommand(chat, link, text));
    const recent = await db.all("SELECT id FROM files WHERE user_id=? AND origin='upload' AND created_at>? ORDER BY created_at DESC LIMIT 3", link.user_id, Date.now() - 20 * 60_000) as any[];
    for (const r of recent) if (!fileIds.includes(r.id)) fileIds.push(r.id);
    return void (await runGoal(chat, link, text, fileIds));
  }

  // Reminder delivery. Runs while the server is awake; overdue reminders go out at the next wake-up, labelled late.
  async function deliverDue() {
    const rows = await db.all("SELECT r.id, r.text, r.due_at, l.chat_id FROM reminders r JOIN tg_links l ON l.user_id=r.user_id WHERE r.status='pending' AND r.due_at<=? LIMIT 20", Date.now()) as any[];
    for (const r of rows) {
      await db.run("UPDATE reminders SET status='sent', sent_at=? WHERE id=? AND status='pending'", Date.now(), r.id);
      const late = Date.now() - Number(r.due_at) > 3 * 60_000;
      await send(String(r.chat_id), `⏰ تذكير: ${r.text}` + (late ? `\n(وصل متأخراً ${Math.round((Date.now() - Number(r.due_at)) / 60000)} دقيقة لأن السيرفر المجاني كان نائماً)` : ''));
    }
    return rows.length;
  }
  let timer: any;
  if (!opt.sync) { timer = setInterval(() => void deliverDue().catch(() => {}), 30_000); timer.unref?.(); setTimeout(() => void deliverDue().catch(() => {}), 3000).unref?.(); app.addHook('onClose', async () => clearInterval(timer)); }

  app.post('/telegram/webhook/:secret', async (req, rep) => {
    if (!eq(String((req.params as any).secret), secret) || !eq(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), secret)) return rep.code(403).send({ ok: false });
    const u = (req.body ?? {}) as any; const chat = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? 'x');
    const p = serial(chat, () => handleUpdate(u)); pending.add(p); void p.finally(() => pending.delete(p));
    if (opt.sync) await p;
    return { ok: true };
  });
  const setup = async (publicUrl: string) => {
    await api('setMyCommands', { commands: [['tasks', 'آخر المهام'], ['files', 'ملفاتك'], ['memory', 'الذاكرة'], ['reminders', 'التذكيرات'], ['agent', 'اختيار الوكيل'], ['status', 'الحالة'], ['help', 'مساعدة']].map(([command, description]) => ({ command, description })) });
    return api('setWebhook', { url: `${publicUrl}/telegram/webhook/${secret}`, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  };
  return { setup, deliverDue, idle: () => Promise.all([...pending]), webhookPath: `/telegram/webhook/${secret}`, secret };
}
