import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config, assertConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.ts';
import { ModelRegistry, buildProviders } from './providers/registry.ts';
import type { Provider } from './providers/types.ts';
import { ProviderError } from './providers/openaiCompat.ts';

const BUILTIN = [
  ['general', 'مساعد عام', 'You are a helpful assistant. Answer in the user\'s language, structured and accurate. If you do not know, say so instead of inventing.'],
  ['coding', 'مساعد البرمجة', 'You are an expert software engineer. Give correct, tested-style code with brief explanations.'],
  ['writing', 'مساعد الكتابة', 'You are a professional writer and editor. Produce clear, well-structured text.'],
  ['study', 'مساعد الدراسة', 'You are a patient tutor. Explain step by step and check understanding.'],
  ['translate', 'مساعد الترجمة', 'You are a professional translator. Translate meaning and tone, not word for word. Output only the translation unless asked.'],
] as const;
const STYLES: Record<string, string> = { formal: 'formal', natural: 'natural and fluent', academic: 'academic', simple: 'simple and easy' };

export async function buildApp(opts: { db?: Db; providers?: Provider[] } = {}) {
  const db = opts.db ?? await openDb();
  const registry = new ModelRegistry(opts.providers ?? buildProviders());
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization'] }, bodyLimit: 1_000_000 });
  const now = () => Date.now();
  let lastTs = 0; const mts = () => (lastTs = Math.max(Date.now() * 1000, lastTs + 1));
  const day = () => new Date().toISOString().slice(0, 10);
  for (const [id, name, ins] of BUILTIN)
    await db.run('INSERT INTO assistants(id,user_id,name,instructions,builtin) VALUES(?,NULL,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name, instructions=excluded.instructions', id, name, ins);

  // simple per-IP rate limit
  const hits = new Map<string, { n: number; t: number }>();
  app.addHook('onRequest', async (req, rep) => {
    const k = req.ip, h = hits.get(k);
    if (!h || now() - h.t > 60_000) hits.set(k, { n: 1, t: now() });
    else if (++h.n > 120) return rep.code(429).send({ error: 'rate_limited', message: 'طلبات كثيرة، حاول بعد دقيقة.' });
    if (req.url === '/health' || req.url.startsWith('/v1/auth/')) return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const uid = m && verifyToken(m[1], config.jwtSecret);
    const u: any = uid && await db.get('SELECT * FROM users WHERE id=?', uid);
    if (!u) return rep.code(401).send({ error: 'unauthorized', message: 'سجّل الدخول أولاً.' });
    (req as any).user = u;
  });
  const U = (req: any) => req.user as { id: string; plan: string; is_guest: number; is_admin: number };

  app.get('/health', async () => ({ ok: true }));

  const tokenFor = (id: string) => signToken(id, config.jwtSecret);
  app.post('/v1/auth/register', async (req, rep) => {
    const { email, password } = (req.body ?? {}) as any;
    if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || password.length < 8)
      return rep.code(400).send({ error: 'invalid', message: 'بريد غير صالح أو كلمة مرور أقل من 8 أحرف.' });
    const e = email.toLowerCase();
    if (await db.get('SELECT 1 FROM users WHERE email=?', e)) return rep.code(409).send({ error: 'exists', message: 'البريد مسجل بالفعل.' });
    const id = randomUUID();
    await db.run('INSERT INTO users(id,email,pass_hash,plan,is_admin,created_at) VALUES(?,?,?,?,?,?)', id, e, hashPassword(password), 'free', config.adminEmails.includes(e) ? 1 : 0, now());
    return { token: tokenFor(id), user: { id, email: e, plan: 'free' } };
  });
  app.post('/v1/auth/login', async (req, rep) => {
    const { email, password } = (req.body ?? {}) as any;
    const u: any = typeof email === 'string' && await db.get('SELECT * FROM users WHERE email=?', email.toLowerCase());
    if (!u || typeof password !== 'string' || !verifyPassword(password, u.pass_hash))
      return rep.code(401).send({ error: 'bad_credentials', message: 'البريد أو كلمة المرور غير صحيحة.' });
    return { token: tokenFor(u.id), user: { id: u.id, email: u.email, plan: u.plan } };
  });
  app.post('/v1/auth/guest', async () => {
    const id = randomUUID();
    await db.run('INSERT INTO users(id,is_guest,plan,created_at) VALUES(?,1,?,?)', id, 'guest', now());
    return { token: tokenFor(id), user: { id, plan: 'guest' } };
  });

  app.get('/v1/me', async (req) => {
    const u = U(req); const used = (await db.get("SELECT count(*) c FROM usage_records WHERE user_id=? AND day=? AND kind='message'", u.id, day()) as any).c;
    const lim = (await db.get('SELECT daily_messages d FROM plan_limits WHERE plan=?', u.plan) as any)?.d ?? 0;
    return { id: u.id, plan: u.plan, guest: !!u.is_guest, usage: { messagesToday: used, dailyLimit: lim } };
  });
  app.delete('/v1/me', async (req, rep) => { await db.run('DELETE FROM users WHERE id=?', U(req).id); return rep.code(204).send(); });

  app.get('/v1/models', async () => ({ models: await registry.models() }));
  app.get('/v1/assistants', async (req) => ({ assistants: await db.all('SELECT id,name,instructions,builtin FROM assistants WHERE builtin=1 OR user_id=?', U(req).id) }));
  app.post('/v1/assistants', async (req, rep) => {
    const { name, instructions } = (req.body ?? {}) as any;
    if (!name || !instructions || String(instructions).length > 4000) return rep.code(400).send({ error: 'invalid', message: 'الاسم والتعليمات مطلوبان.' });
    const id = randomUUID(); await db.run('INSERT INTO assistants(id,user_id,name,instructions) VALUES(?,?,?,?)', id, U(req).id, String(name).slice(0, 80), String(instructions));
    return { id, name };
  });

  const ownConv = async (req: any): Promise<any> => db.get('SELECT * FROM conversations WHERE id=? AND user_id=?', req.params.id, U(req).id);
  app.get('/v1/conversations', async (req) => {
    const { q, archived } = req.query as any;
    const rows = q
      ? await db.all(`SELECT DISTINCT c.* FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.user_id=? AND c.archived=? AND (LOWER(c.title) LIKE LOWER(?) OR LOWER(m.content) LIKE LOWER(?)) ORDER BY c.updated_at DESC LIMIT 100`, U(req).id, archived ? 1 : 0, `%${q}%`, `%${q}%`)
      : await db.all('SELECT * FROM conversations WHERE user_id=? AND archived=? ORDER BY updated_at DESC LIMIT 100', U(req).id, archived ? 1 : 0);
    return { conversations: rows };
  });
  app.post('/v1/conversations', async (req) => {
    const { title, model, assistantId } = (req.body ?? {}) as any; const id = randomUUID();
    await db.run('INSERT INTO conversations(id,user_id,title,model,assistant_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, U(req).id, title ?? 'محادثة جديدة', model ?? null, assistantId ?? 'general', now(), now());
    return { id };
  });
  app.get('/v1/conversations/:id', async (req, rep) => {
    const c = await ownConv(req); if (!c) return rep.code(404).send({ error: 'not_found' });
    return { conversation: c, messages: await db.all('SELECT id,role,content,model,created_at FROM messages WHERE conversation_id=? ORDER BY created_at', c.id) };
  });
  app.patch('/v1/conversations/:id', async (req, rep) => {
    const c = await ownConv(req); if (!c) return rep.code(404).send({ error: 'not_found' });
    const b = (req.body ?? {}) as any;
    await db.run('UPDATE conversations SET title=?, archived=?, model=? WHERE id=?', b.title ?? c.title, b.archived === undefined ? c.archived : b.archived ? 1 : 0, b.model ?? c.model, c.id);
    return { ok: true };
  });
  app.delete('/v1/conversations/:id', async (req, rep) => {
    const c = await ownConv(req); if (!c) return rep.code(404).send({ error: 'not_found' });
    await db.run('DELETE FROM conversations WHERE id=?', c.id); return rep.code(204).send();
  });

  // Streaming chat (SSE). Body: {content, model:"provider:model", style?, regenerate?, editMessageId?}
  app.post('/v1/conversations/:id/messages', async (req, rep) => {
    const u = U(req), c = await ownConv(req); if (!c) return rep.code(404).send({ error: 'not_found' });
    const b = (req.body ?? {}) as any;
    const limit = (await db.get('SELECT daily_messages d FROM plan_limits WHERE plan=?', u.plan) as any)?.d ?? 0;
    const used = (await db.get("SELECT count(*) c FROM usage_records WHERE user_id=? AND day=? AND kind='message'", u.id, day()) as any).c;
    if (used >= limit) return rep.code(429).send({ error: 'quota', message: 'وصلت للحد اليومي للرسائل في باقتك.' });
    const modelSel: string = b.model ?? c.model ?? '';
    const [pn, ...rest] = modelSel.split(':'); const mid = rest.join(':');
    const prov = registry.provider(pn);
    const avail = await registry.models();
    if (!prov || !avail.some(m => m.provider === pn && m.id === mid))
      return rep.code(400).send({ error: 'model_unavailable', message: 'هذا النموذج غير متاح حالياً. اختر نموذجاً من القائمة.' });
    if (b.editMessageId) { // delete that message and everything after it
      const m: any = await db.get('SELECT created_at r FROM messages WHERE id=? AND conversation_id=?', b.editMessageId, c.id);
      if (m) await db.run('DELETE FROM messages WHERE conversation_id=? AND created_at>=?', c.id, m.r);
    }
    if (b.regenerate) {
      const last: any = await db.get("SELECT id,role FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1", c.id);
      if (last?.role === 'assistant') await db.run('DELETE FROM messages WHERE id=?', last.id);
    } else {
      if (typeof b.content !== 'string' || !b.content.trim() || b.content.length > 20000) return rep.code(400).send({ error: 'invalid', message: 'الرسالة فارغة أو طويلة جداً.' });
      await db.run('INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)', randomUUID(), c.id, 'user', b.content, mts());
    }
    const asst: any = await db.get('SELECT instructions FROM assistants WHERE id=? AND (builtin=1 OR user_id=?)', c.assistant_id ?? 'general', u.id);
    let sys = asst?.instructions ?? '';
    if (b.style && STYLES[b.style]) sys += ` Translation style: ${STYLES[b.style]}.`;
    const history = await db.all('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at', c.id) as any[];
    const msgs = [...(sys ? [{ role: 'system' as const, content: sys }] : []), ...history.slice(-40)];

    rep.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (ev: string, d: unknown) => rep.raw.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    const ac = new AbortController(); rep.raw.on('close', () => ac.abort());
    let out = '';
    try {
      for await (const t of prov.chatStream(mid, msgs, ac.signal)) { out += t; send('delta', { t }); }
      if (!out) throw new ProviderError(502, 'empty response');
      const id = randomUUID();
      await db.run('INSERT INTO messages(id,conversation_id,role,content,model,created_at) VALUES(?,?,?,?,?,?)', id, c.id, 'assistant', out, modelSel, mts());
      await db.run('UPDATE conversations SET updated_at=?, model=?, title=CASE WHEN title=CAST(? AS TEXT) THEN CAST(? AS TEXT) ELSE title END WHERE id=?', now(), modelSel, 'محادثة جديدة', (history[0]?.content ?? '').slice(0, 40), c.id);
      await db.run('INSERT INTO usage_records(user_id,day,kind,model,chars_in,chars_out) VALUES(?,?,?,?,?,?)', u.id, day(), 'message', modelSel, JSON.stringify(msgs).length, out.length);
      send('done', { id });
    } catch (e: any) {
      if (out && ac.signal.aborted) { // user stopped: keep partial answer
        await db.run('INSERT INTO messages(id,conversation_id,role,content,model,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), c.id, 'assistant', out, modelSel, mts());
      } else {
        const st = e?.status ?? 0;
        send('error', { message: st === 429 ? 'خدمة الذكاء الاصطناعي مشغولة أو وصلت للحد المجاني. حاول لاحقاً.' : 'تعذر الحصول على رد من النموذج.', status: st });
        req.log.error({ status: st }, 'provider error');
      }
    }
    rep.raw.end();
  });

  app.get('/v1/admin/stats', async (req, rep) => {
    if (!U(req).is_admin) return rep.code(403).send({ error: 'forbidden' });
    const g = async (s: string) => Number((await db.get(s)).c);
    return { users: await g('SELECT count(*) c FROM users'), conversations: await g('SELECT count(*) c FROM conversations'), messages: await g('SELECT count(*) c FROM messages'),
      usageByModel: (await db.all("SELECT model, count(*) n, sum(chars_in) cin, sum(chars_out) cout FROM usage_records GROUP BY model")).map((r: any) => ({ ...r, n: Number(r.n), cin: Number(r.cin), cout: Number(r.cout) })) };
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertConfig();
  (await buildApp()).listen({ port: config.port, host: '0.0.0.0' });
}
