import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import type { Provider, ChatMsg } from './providers/types.ts';
import { TOOLS, AGENTS, toolSpecs, type ToolCtx } from './tools/index.ts';
import { memoryPrompt } from './memory.ts';
import { extractText, isImage } from './files.ts';

export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'partially_completed' | 'canceled';
export type Emit = (event: string, data: any) => void;
const MAX_ITER = 6;
const MAX_TOOL_OUT = 10000;
const HONESTY = `Rules: Be honest. Never claim you did something unless a tool result shows it. Never invent prices, dates, availability, sources or file contents. If a tool fails, say so plainly and in the same message offer the closest thing you CAN do or say exactly what is needed to proceed. Never answer with a bare "I can't"; always propose a concrete next step. You have tools for images (generate_image, edit_image), documents and project zips: use them instead of refusing. Label facts (with sources) vs assumptions vs predictions. Do not take decisions for the user. Do not send, pay, book or publish anything. Answer in the user's language (Arabic by default).
Style (Instinct-like): reply in short, warm Egyptian Arabic (a few sentences, no long lectures, no headings unless a list helps). Act first: when a request is clear, do it end to end with your tools and report the FINISHED result (what you made, where it is, what was verified), not a plan. If one route fails, try another route yourself before reporting a problem. Ask the user only for things only he can supply (a decision, a private detail, a file); never ask for things you can find or decide. When something is unverified, say so in one short line. Offer a useful follow-up or a reminder when it fits, but do not do unrequested actions. Never fake a result.`;
export interface TaskState { messages: ChatMsg[]; pending: { id: string; name: string; arguments: string }[]; approved: string[]; rejected: string[]; iter: number }

export async function createTask(db: Db, o: { userId: string; goal: string; agent?: string; model: string; conversationId?: string | null; fileIds?: string[] }) {
  const agent = AGENTS[o.agent ?? 'general'] ?? AGENTS.general; const id = randomUUID(); const now = Date.now();
  const nowStr = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.TIMEZONE ?? 'Africa/Cairo', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  const sys = agent.instructions + '\n' + HONESTY + `\nCurrent date and time: ${nowStr} (${process.env.TIMEZONE ?? 'Africa/Cairo'}).` + (await memoryPrompt(db, o.userId));
  let goal = o.goal;
  if (o.fileIds?.length) {
    const rows = await db.all(`SELECT id,name FROM files WHERE user_id=? AND id IN (${o.fileIds.map(() => '?').join(',')})`, o.userId, ...o.fileIds) as any[];
    if (rows.length) goal += '\n\n[Attached files: ' + rows.map(r => `${r.name} (file_id: ${r.id})`).join(', ') + ']';
  }
  const state: TaskState = { messages: [{ role: 'system', content: sys }, { role: 'user', content: goal }], pending: [], approved: [], rejected: [], iter: 0 };
  await db.run('INSERT INTO tasks(id,user_id,conversation_id,title,agent,model,status,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, o.userId, o.conversationId ?? null, o.goal.slice(0, 80), agent.id, o.model, 'pending', JSON.stringify(state), now, now);
  return id;
}
const setStatus = (db: Db, id: string, status: TaskStatus, extra: { result?: string; error?: string; state?: TaskState } = {}) =>
  db.run('UPDATE tasks SET status=?, updated_at=?, result=COALESCE(?,result), error=COALESCE(?,error), state=COALESCE(?,state) WHERE id=?', status, Date.now(), extra.result ?? null, extra.error ?? null, extra.state ? JSON.stringify(extra.state) : null, id);
async function addStep(db: Db, taskId: string, kind: string, tool: string | null, args: unknown, output: unknown, status: string, error?: string) {
  const n: any = await db.get('SELECT count(*) c FROM task_steps WHERE task_id=?', taskId); const idx = Number(n.c) + 1;
  const o = output === undefined ? null : JSON.stringify(output).slice(0, 20000);
  await db.run('INSERT INTO task_steps(id,task_id,idx,kind,tool,args,output,status,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', randomUUID(), taskId, idx, kind, tool, args === undefined ? null : JSON.stringify(args), o, status, error ?? null, Date.now());
  return idx;
}
const transient = (m: string) => /fetch failed|timeout|timed out|HTTP (5\d\d|429)|ECONN|ETIMEDOUT|429|503/i.test(m);
const preview = (o: unknown) => JSON.stringify(o)?.slice(0, 300);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Runs (or resumes) a task until it finishes or needs approval. */
export async function runTask(db: Db, provider: Provider, taskId: string, emit: Emit, signal: AbortSignal, opts: { fetchImpl?: typeof fetch; retryDelayMs?: number } = {}) {
  const t: any = await db.get('SELECT * FROM tasks WHERE id=?', taskId); if (!t) throw new Error('task not found');
  const agent = AGENTS[t.agent] ?? AGENTS.general; const st: TaskState = JSON.parse(t.state);
  const specs = toolSpecs(agent.tools);
  const ctx: ToolCtx = { db, userId: t.user_id, taskId, provider, model: String(t.model).split(':').slice(1).join(':'), signal, fetchImpl: opts.fetchImpl };
  await setStatus(db, taskId, 'running'); emit('task', { id: taskId, status: 'running', agent: agent.id });
  const cancelled = async () => ((await db.get('SELECT status s FROM tasks WHERE id=?', taskId)) as any)?.s === 'canceled' || signal.aborted;
  let failures = 0, recovered = new Set<string>(); const failedTools = new Set<string>();
  const prior: any = await db.get("SELECT count(*) c FROM task_steps WHERE task_id=? AND status='failed'", taskId); failures = Number(prior.c);
  try {
    for (;;) {
      // 1. drain pending tool calls (also how a task resumes after approval)
      while (st.pending.length) {
        if (await cancelled()) { await setStatus(db, taskId, 'canceled', { state: st }); emit('done', { taskId, status: 'canceled' }); return; }
        const call = st.pending[0]; const tool = TOOLS[call.name];
        let args: any = {}; try { args = JSON.parse(call.arguments || '{}'); } catch { /* handled below */ }
        const push = (content: string) => { st.pending.shift(); st.messages.push({ role: 'tool', tool_call_id: call.id, content: content.slice(0, MAX_TOOL_OUT) }); };
        if (!tool || !agent.tools.includes(call.name)) { await addStep(db, taskId, 'tool', call.name, args, undefined, 'failed', 'unknown tool'); failures++; failedTools.add(call.name); push(JSON.stringify({ error: 'unknown tool' })); continue; }
        if (tool.needsApproval && !st.approved.includes(call.id)) {
          if (st.rejected.includes(call.id)) { await addStep(db, taskId, 'approval', call.name, args, { decision: 'rejected' }, 'rejected'); push(JSON.stringify({ error: 'the user rejected this action' })); continue; }
          const idx = await addStep(db, taskId, 'approval', call.name, args, undefined, 'waiting');
          await setStatus(db, taskId, 'waiting_approval', { state: st });
          emit('approval', { taskId, callId: call.id, step: idx, tool: call.name, args }); emit('done', { taskId, status: 'waiting_approval' }); return;
        }
        let out: any, lastErr = '', ok = false, verified: any, fileId: string | undefined;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try { const r = await tool.run(args, ctx); out = r.output; verified = r.verified; fileId = r.fileId; ok = true; }
          catch (e: any) { lastErr = String(e?.message ?? e).slice(0, 300); if (!transient(lastErr) || attempt) break; await sleep(opts.retryDelayMs ?? 1000); }
        }
        if (ok) {
          if (tool.compactArgs) for (const m of st.messages) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) if (tc.id === call.id) tc.function.arguments = JSON.stringify(tool.compactArgs(args));
          const idx = await addStep(db, taskId, 'tool', call.name, args, out, 'ok'); recovered.add(call.name);
          emit('step', { idx, kind: 'tool', tool: call.name, status: 'ok', preview: preview(out) });
          if (verified) { const vi = await addStep(db, taskId, 'verify', call.name, { fileId }, verified, verified.ok ? 'ok' : 'failed'); emit('step', { idx: vi, kind: 'verify', tool: call.name, status: verified.ok ? 'ok' : 'failed', preview: verified.detail }); }
          if (fileId) emit('file', { taskId, fileId, ...(out as any) });
          push(JSON.stringify(out));
        } else {
          failures++; failedTools.add(call.name); recovered.delete(call.name);
          const idx = await addStep(db, taskId, 'tool', call.name, args, undefined, 'failed', lastErr);
          emit('step', { idx, kind: 'tool', tool: call.name, status: 'failed', preview: lastErr });
          push(JSON.stringify({ error: lastErr }));
        }
        await setStatus(db, taskId, 'running', { state: st });
      }
      // 2. ask the model
      if (await cancelled()) { await setStatus(db, taskId, 'canceled', { state: st }); emit('done', { taskId, status: 'canceled' }); return; }
      const cap = agent.maxIter ?? MAX_ITER; if (st.iter >= cap) throw new Error('تجاوزت المهمة الحد الأقصى لعدد الخطوات (' + cap + ').');
      st.iter++;
      if (!provider.chat) throw new Error('provider has no tool-calling support');
      let resp: Awaited<ReturnType<NonNullable<Provider['chat']>>> | undefined, err: any;
      for (let a = 0; a < 2 && !resp; a++) { try { resp = await provider.chat(ctx.model, st.messages, specs, signal); } catch (e: any) { err = e; if (!transient(String(e?.status ?? e?.message)) || a) break; await sleep(opts.retryDelayMs ?? (e?.status === 429 ? 20000 : 1000)); } }
      if (!resp) throw err;
      if (resp.toolCalls.length) {
        st.messages.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments }, ...(c.extra ? { extra_content: c.extra } : {}) })) });
        st.pending = resp.toolCalls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }));
        await addStep(db, taskId, 'model', null, resp.toolCalls.map(c => c.name), undefined, 'ok');
        continue;
      }
      // 3. final answer + verification of produced files
      const final = resp.content.trim(); if (!final) throw new Error('النموذج أعاد رداً فارغاً.');
      const files = await db.all('SELECT id,name,data FROM files WHERE task_id=?', taskId) as any[];
      let filesOk = true;
      for (const f of files) { if (isImage(f.name)) continue; try { const txt = await extractText(f.name, Buffer.from(f.data, 'base64')); if (!txt && !/\.xlsx$/.test(f.name)) filesOk = false; } catch { filesOk = false; } }
      if (files.length) { const vi = await addStep(db, taskId, 'verify', 'final', { files: files.map(f => f.name) }, { reopened: filesOk }, filesOk ? 'ok' : 'failed'); emit('step', { idx: vi, kind: 'verify', tool: 'final', status: filesOk ? 'ok' : 'failed', preview: filesOk ? 'أعيد فتح كل الملفات الناتجة' : 'تعذر فتح بعض الملفات' }); if (!filesOk) failures++; }
      const unrecovered = [...failedTools].filter(n => !recovered.has(n));
      const status: TaskStatus = (unrecovered.length || !filesOk) ? 'partially_completed' : 'completed';
      await addStep(db, taskId, 'final', null, undefined, { chars: final.length }, 'ok');
      await setStatus(db, taskId, status, { result: final, state: st });
      emit('delta', { t: final }); emit('done', { taskId, status }); return;
    }
  } catch (e: any) {
    if (await cancelled()) { await setStatus(db, taskId, 'canceled', { state: st }); emit('done', { taskId, status: 'canceled' }); return; }
    const msg = e?.status === 429 ? 'خدمة الذكاء الاصطناعي مشغولة أو وصلت للحد المجاني. حاول لاحقاً.' : String(e?.message ?? e).slice(0, 300);
    await addStep(db, taskId, 'error', null, undefined, undefined, 'failed', msg);
    await setStatus(db, taskId, 'failed', { error: msg, state: st });
    emit('error', { message: msg }); emit('done', { taskId, status: 'failed' });
  }
}
export async function decide(db: Db, taskId: string, userId: string, callId: string, approve: boolean) {
  const t: any = await db.get('SELECT * FROM tasks WHERE id=? AND user_id=?', taskId, userId);
  if (!t) return 'not_found'; if (t.status !== 'waiting_approval') return 'not_waiting';
  const st: TaskState = JSON.parse(t.state); if (!st.pending.some(c => c.id === callId)) return 'unknown_call';
  (approve ? st.approved : st.rejected).push(callId);
  await db.run('UPDATE tasks SET state=?, updated_at=? WHERE id=?', JSON.stringify(st), Date.now(), taskId);
  await db.run("UPDATE task_steps SET status=? WHERE task_id=? AND kind='approval' AND status='waiting'", approve ? 'approved' : 'rejected', taskId);
  return 'ok';
}
