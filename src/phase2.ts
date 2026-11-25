import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import type { ModelRegistry } from './providers/registry.ts';
import { createTask, runTask, decide, type Emit } from './agent.ts';
import { AGENTS } from './tools/index.ts';
import { addMemory, MemoryError, memoryEnabled } from './memory.ts';
import { extractText, isImage, extOf, MIME, MAX_UPLOAD } from './files.ts';

export interface AgentUser { id: string; plan: string }
const day = () => new Date().toISOString().slice(0, 10);

/** Shared by the HTTP API and the Telegram adapter. */
export function makeService(db: Db, registry: ModelRegistry, fetchImpl?: typeof fetch) {
  async function defaultModel(): Promise<string | null> { const m = (await registry.models())[0]; return m ? `${m.provider}:${m.id}` : null; }
  async function checkQuota(u: AgentUser) {
    const limit = ((await db.get('SELECT daily_messages d FROM plan_limits WHERE plan=?', u.plan)) as any)?.d ?? 0;
    const used = Number(((await db.get("SELECT count(*) c FROM usage_records WHERE user_id=? AND day=? AND kind='message'", u.id, day())) as any).c);
    return used < limit;
  }
  async function start(u: AgentUser, o: { goal: string; model?: string; agent?: string; conversationId?: string | null; fileIds?: string[] }, emit: Emit, signal: AbortSignal) {
    if (!(await checkQuota(u))) return { error: 'quota', message: 'وصلت للحد اليومي للرسائل في باقتك.' } as const;
    const model = o.model || await defaultModel(); const [pn, ...rest] = (model ?? '').split(':');
    const prov = registry.provider(pn); const avail = await registry.models();
    if (!prov || !avail.some(m => m.provider === pn && m.id === rest.join(':'))) return { error: 'model_unavailable', message: 'هذا النموذج غير متاح حالياً.' } as const;
    if (!o.goal?.trim() || o.goal.length > 20000) return { error: 'invalid', message: 'الطلب فارغ أو طويل جداً.' } as const;
    if (o.agent && !AGENTS[o.agent]) return { error: 'invalid', message: 'وكيل غير معروف.' } as const;
    let convId = o.conversationId ?? null;
    if (convId && !(await db.get('SELECT 1 x FROM conversations WHERE id=? AND user_id=?', convId, u.id))) return { error: 'not_found', message: 'المحادثة غير موجودة.' } as const;
    const taskId = await createTask(db, { userId: u.id, goal: o.goal, agent: o.agent, model: model!, conversationId: convId, fileIds: o.fileIds });
    await db.run('INSERT INTO usage_records(user_id,day,kind,model,chars_in,chars_out) VALUES(?,?,?,?,?,?)', u.id, day(), 'message', model, o.goal.length, 0);
    const wrapped: Emit = (ev, d) => { emit(ev, d); };
    emit('task', { id: taskId, status: 'pending' });
    return { taskId, run: () => runTask(db, prov, taskId, wrapped, signal, { fetchImpl }), prov } as const;
  }
  async function resume(u: AgentUser, taskId: string, callId: string, approve: boolean, emit: Emit, signal: AbortSignal) {
    const r = await decide(db, taskId, u.id, callId, approve); if (r !== 'ok') return { error: r } as const;
    const t: any = await db.get('SELECT model FROM tasks WHERE id=?', taskId); const prov = registry.provider(String(t.model).split(':')[0]);
    if (!prov) return { error: 'model_unavailable' } as const;
    return { run: () => runTask(db, prov, taskId, emit, signal, { fetchImpl }) } as const;
  }
  async function restart(taskId: string, emit: Emit, signal: AbortSignal) {
    const t: any = await db.get('SELECT model FROM tasks WHERE id=?', taskId); if (!t) return null; const prov = registry.provider(String(t.model).split(':')[0]); if (!prov) return null;
    return { run: () => runTask(db, prov, taskId, emit, signal, { fetchImpl }) } as const;
  }
  async function storeFile(u: AgentUser, name: string, buf: Buffer, mime?: string) {
    if (buf.length > MAX_UPLOAD) throw Object.assign(new Error('الملف أكبر من 10 ميجا.'), { code: 'too_large' });
    const ext = extOf(name); if (!MIME[ext]) throw Object.assign(new Error('نوع الملف غير مدعوم: ' + ext), { code: 'unsupported' });
    const used: any = await db.get("SELECT COALESCE(SUM(size),0) s FROM files WHERE user_id=?", u.id);
    if (Number(used.s) + buf.length > 60 * 1024 * 1024) throw Object.assign(new Error('تجاوزت مساحة الملفات (60 ميجا). احذف بعض الملفات.'), { code: 'quota' });
    let text: string | null = null;
    if (!isImage(name)) { try { text = await extractText(name, buf); } catch (e: any) { throw Object.assign(new Error('تعذر قراءة الملف: ' + e.message), { code: 'unreadable' }); } }
    const id = randomUUID();
    await db.run('INSERT INTO files(id,user_id,name,mime,size,origin,text,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, u.id, name.slice(0, 120), mime || MIME[ext], buf.length, 'upload', text, buf.toString('base64'), Date.now());
    return { id, name, size: buf.length, chars: text?.length ?? null };
  }
  return { start, resume, restart, storeFile, defaultModel };
}
export type Service = ReturnType<typeof makeService>;

export function registerPhase2(app: FastifyInstance, db: Db, svc: Service, U: (req: any) => AgentUser) {
  const sse = (rep: any) => { rep.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); return (ev: string, d: unknown) => rep.raw.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`); };
  const abortOnClose = (rep: any) => { const ac = new AbortController(); rep.raw.on('close', () => ac.abort()); return ac; };
  const lastAssistantSave = (db2: Db) => async (u: AgentUser, convId: string, taskId: string) => {
    const t: any = await db2.get('SELECT result,model FROM tasks WHERE id=?', taskId);
    if (t?.result) await db2.run('INSERT INTO messages(id,conversation_id,role,content,model,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), convId, 'assistant', t.result, t.model, Date.now() * 1000 + 5);
  };
  const saveAnswer = lastAssistantSave(db);

  app.get('/v1/agents', async () => ({ agents: Object.values(AGENTS).map(a => ({ id: a.id, name: a.name, tools: a.tools })) }));

  // Run a task (SSE): events task | step | file | approval | delta | error | done
  app.post('/v1/agent/run', async (req, rep) => {
    const u = U(req); const b = (req.body ?? {}) as any;
    let convId: string | null = b.conversationId ?? null;
    if (!convId) { convId = randomUUID(); await db.run('INSERT INTO conversations(id,user_id,title,model,assistant_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', convId, u.id, String(b.goal ?? '').slice(0, 40) || 'مهمة', b.model ?? null, 'general', Date.now(), Date.now()); }
    const noop = () => {};
    const probe = await svc.start(u, { goal: b.goal, model: b.model, agent: b.agent, conversationId: convId, fileIds: b.fileIds }, noop, new AbortController().signal).catch((e: any) => ({ error: 'internal', message: String(e.message) } as any));
    if ('error' in probe) return rep.code(probe.error === 'quota' ? 429 : probe.error === 'not_found' ? 404 : 400).send(probe);
    // The probe already created the task; run it with a real emitter.
    const send = sse(rep); const ac = abortOnClose(rep);
    await db.run('INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)', randomUUID(), convId, 'user', b.goal, Date.now() * 1000);
    send('task', { id: probe.taskId, status: 'pending', conversationId: convId });
    await db.run('UPDATE tasks SET conversation_id=? WHERE id=?', convId, probe.taskId);
    const { runTask: _r } = await import('./agent.ts');
    await _r(db, probe.prov, probe.taskId, (ev, d) => { if (ev !== 'task') send(ev, d); else send(ev, { ...d, conversationId: convId }); }, ac.signal, {});
    await saveAnswer(u, convId, probe.taskId);
    rep.raw.end();
  });
  app.post('/v1/tasks/:id/approve', async (req, rep) => {
    const u = U(req); const b = (req.body ?? {}) as any; const id = (req.params as any).id;
    const send = sse(rep); const ac = abortOnClose(rep);
    const r = await svc.resume(u, id, String(b.callId ?? ''), !!b.approve, send, ac.signal);
    if ('error' in r) { send('error', { message: r.error }); return rep.raw.end(); }
    await r.run(); const t: any = await db.get('SELECT conversation_id c FROM tasks WHERE id=?', id); if (t?.c) await saveAnswer(u, t.c, id);
    rep.raw.end();
  });
  app.get('/v1/tasks', async (req) => ({ tasks: await db.all('SELECT id,title,agent,model,status,conversation_id,created_at,updated_at FROM tasks WHERE user_id=? ORDER BY updated_at DESC LIMIT 100', U(req).id) }));
  app.get('/v1/tasks/:id', async (req, rep) => {
    const t: any = await db.get('SELECT id,title,agent,model,status,result,error,conversation_id,created_at,updated_at FROM tasks WHERE id=? AND user_id=?', (req.params as any).id, U(req).id);
    if (!t) return rep.code(404).send({ error: 'not_found' });
    const steps = await db.all('SELECT idx,kind,tool,args,output,status,error,created_at FROM task_steps WHERE task_id=? ORDER BY idx', t.id);
    const files = await db.all('SELECT id,name,size,mime FROM files WHERE task_id=? AND user_id=?', t.id, U(req).id);
    return { task: t, steps, files };
  });
  app.post('/v1/tasks/:id/cancel', async (req, rep) => {
    const r: any = await db.get('SELECT status FROM tasks WHERE id=? AND user_id=?', (req.params as any).id, U(req).id);
    if (!r) return rep.code(404).send({ error: 'not_found' });
    if (['completed', 'failed', 'partially_completed', 'canceled'].includes(r.status)) return rep.code(409).send({ error: 'finished', message: 'المهمة انتهت بالفعل.' });
    await db.run("UPDATE tasks SET status='canceled', updated_at=? WHERE id=?", Date.now(), (req.params as any).id);
    return { ok: true };
  });

  // Files (JSON upload: {name, dataBase64})
  app.post('/v1/files', { bodyLimit: 16 * 1024 * 1024 }, async (req, rep) => {
    const b = (req.body ?? {}) as any;
    if (typeof b.name !== 'string' || typeof b.dataBase64 !== 'string') return rep.code(400).send({ error: 'invalid', message: 'name و dataBase64 مطلوبان.' });
    try { return await svc.storeFile(U(req), b.name, Buffer.from(b.dataBase64, 'base64'), b.mimeType); }
    catch (e: any) { return rep.code(e.code ? 400 : 500).send({ error: e.code ?? 'internal', message: e.message }); }
  });
  app.get('/v1/files', async (req) => ({ files: await db.all('SELECT id,name,mime,size,origin,task_id,created_at FROM files WHERE user_id=? ORDER BY created_at DESC LIMIT 200', U(req).id) }));
  app.get('/v1/files/:id/download', async (req, rep) => {
    const f: any = await db.get('SELECT name,mime,data FROM files WHERE id=? AND user_id=?', (req.params as any).id, U(req).id);
    if (!f) return rep.code(404).send({ error: 'not_found' });
    return rep.header('content-type', f.mime).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(Buffer.from(f.data, 'base64'));
  });
  app.delete('/v1/files/:id', async (req, rep) => { await db.run('DELETE FROM files WHERE id=? AND user_id=?', (req.params as any).id, U(req).id); return rep.code(204).send(); });

  // Memory
  app.get('/v1/memory', async (req) => ({ enabled: await memoryEnabled(db, U(req).id), items: await db.all('SELECT id,kind,content,created_at FROM memories WHERE user_id=? ORDER BY created_at DESC', U(req).id) }));
  app.post('/v1/memory', async (req, rep) => {
    try { return await addMemory(db, U(req).id, String(((req.body ?? {}) as any).content ?? '')); }
    catch (e: any) { if (e instanceof MemoryError) return rep.code(400).send({ error: e.code, message: e.message }); throw e; }
  });
  app.delete('/v1/memory/:id', async (req, rep) => { await db.run('DELETE FROM memories WHERE id=? AND user_id=?', (req.params as any).id, U(req).id); return rep.code(204).send(); });
  app.delete('/v1/memory', async (req, rep) => { await db.run('DELETE FROM memories WHERE user_id=?', U(req).id); return rep.code(204).send(); });
  app.patch('/v1/memory/settings', async (req) => {
    const en = ((req.body ?? {}) as any).enabled ? 1 : 0;
    await db.run('INSERT INTO user_settings(user_id,memory_enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET memory_enabled=excluded.memory_enabled', U(req).id, en);
    return { enabled: !!en };
  });
}
