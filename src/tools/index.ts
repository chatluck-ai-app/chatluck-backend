import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Db } from '../db.ts';
import type { Provider, ToolSpec } from '../providers/types.ts';
import { addMemory, MemoryError } from '../memory.ts';
import { createDocument, verifyDocument, extractText, isImage, extOf, MIME, type DocSpec } from '../files.ts';

export interface ToolCtx { db: Db; userId: string; taskId: string; provider: Provider; model: string; signal: AbortSignal; fetchImpl?: typeof fetch }
export interface Tool extends ToolSpec { needsApproval?: boolean; run(args: any, ctx: ToolCtx): Promise<{ output: any; verified?: { ok: boolean; detail: string }; fileId?: string }> }

/** Blocks private/loopback/link-local targets (SSRF). */
export function isPrivateIp(ip: string) {
  if (ip.includes(':')) { const l = ip.toLowerCase(); return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.') || l === '::'; }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export async function assertPublicUrl(u: string) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http/https URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('this address is not allowed');
  return url;
}
export function htmlToText(html: string) {
  return html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const webSearch: Tool = {
  name: 'web_search', description: 'Search the web (Google Search grounding). Returns an answer with source links. Use for anything recent or factual; always cite the sources.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async run({ query }, ctx) {
    if (!ctx.provider.search) throw new Error('web search is not available on this provider');
    const r = await ctx.provider.search(String(query).slice(0, 400), ctx.signal);
    if (!r.sources.length) return { output: { answer: r.answer, sources: [], note: 'No sources were returned; treat this as UNCONFIRMED.' } };
    return { output: r };
  },
};
const webRead: Tool = {
  name: 'web_read', description: 'Open a public web page by URL and return its readable text (first 12000 chars).',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async run({ url }, ctx) {
    let cur = await assertPublicUrl(String(url)); let r: Response | undefined;
    const f = ctx.fetchImpl ?? fetch;
    for (let i = 0; i < 4; i++) { // follow redirects manually, re-checking each hop
      r = await f(cur, { redirect: 'manual', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]), headers: { 'user-agent': 'ChatLuckBot/1.0', accept: 'text/html,text/plain,application/xhtml+xml' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { cur = await assertPublicUrl(new URL(loc, cur).toString()); continue; }
      break;
    }
    if (!r || !r.ok) throw new Error('HTTP ' + r?.status);
    const ct = r.headers.get('content-type') ?? '';
    if (!/text\/|html|xml|json/.test(ct)) throw new Error('unsupported content type: ' + ct);
    const raw = (await r.text()).slice(0, 1_500_000);
    const text = /html/.test(ct) ? htmlToText(raw) : raw;
    return { output: { url: cur.toString(), text: text.slice(0, 12000), truncated: text.length > 12000 } };
  },
};
const readFile: Tool = {
  name: 'read_file', description: 'Read a file the user uploaded (PDF, DOCX, XLSX, PPTX, TXT, CSV, images). For images returns a description plus any text found. Use offset to read further into long files.',
  parameters: { type: 'object', properties: { file_id: { type: 'string' }, offset: { type: 'integer' } }, required: ['file_id'] },
  async run({ file_id, offset }, ctx) {
    const f: any = await ctx.db.get('SELECT * FROM files WHERE id=? AND user_id=?', file_id, ctx.userId);
    if (!f) throw new Error('file not found');
    if (isImage(f.name)) {
      if (!ctx.provider.chat) throw new Error('image reading is not available');
      const r = await ctx.provider.chat(ctx.model, [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image in detail and transcribe all visible text exactly (Arabic and English). Answer in the language of the text.' },
        { type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } }] }], [], ctx.signal);
      return { output: { name: f.name, description: r.content } };
    }
    const t: string = f.text ?? ''; const o = Math.max(0, Number(offset) || 0);
    return { output: { name: f.name, total_chars: t.length, offset: o, text: t.slice(o, o + 12000), has_more: t.length > o + 12000 } };
  },
};
const createDoc: Tool = {
  name: 'create_document', description: 'Create a real file for the user: docx, xlsx, pptx or pdf (pdf supports Latin text only; use docx for Arabic). docx/pdf/pptx take sections [{heading, body, bullets[]}]; xlsx takes sheets [{name, rows[[...]]}]. The file is re-opened and verified automatically.',
  parameters: { type: 'object', properties: { type: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] }, title: { type: 'string' },
    sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } },
    sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: {} } } } } } }, required: ['type', 'title'] },
  async run(args, ctx) {
    const spec = args as DocSpec;
    const doc = await createDocument(spec);
    const verified = await verifyDocument(spec, doc.buf, doc.name);
    if (!verified.ok) throw new Error('verification failed: ' + verified.detail);
    const id = randomUUID();
    await ctx.db.run('INSERT INTO files(id,user_id,name,mime,size,origin,text,data,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ctx.userId, doc.name, doc.mime, doc.buf.length, 'generated', null, doc.buf.toString('base64'), ctx.taskId, Date.now());
    return { output: { file_id: id, name: doc.name, size: doc.buf.length }, verified, fileId: id };
  },
};
const saveMemory: Tool = {
  name: 'save_memory', needsApproval: true, description: 'Save a short preference or fact the user asked you to remember. Never passwords, card numbers or secrets. Requires the user to approve.',
  parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  async run({ content }, ctx) {
    try { return { output: await addMemory(ctx.db, ctx.userId, String(content)) }; }
    catch (e) { if (e instanceof MemoryError) throw new Error(e.message); throw e; }
  },
};
/** Parses "YYYY-MM-DD HH:MM" as wall-clock time in `tz` and returns epoch ms. */
export function localToEpoch(local: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(local.trim()); if (!m) return null;
  const [Y, M, D, h, mi] = m.slice(1).map(Number); const wall = Date.UTC(Y, M - 1, D, h, mi);
  const offsetAt = (t: number) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map(x => [x.type, Number(x.value)])) as any; return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t; };
  let t = wall - offsetAt(wall); t = wall - offsetAt(t); return t;
}
export const TZ = () => process.env.TIMEZONE ?? 'Africa/Cairo';
const createReminder: Tool = {
  name: 'create_reminder', description: 'Create a reminder that is sent to the user on Telegram at a given local time. "when" is local wall-clock time as YYYY-MM-DD HH:MM in the user\'s timezone (see current time in the system prompt). Delivery is best effort: the free server can be asleep, so a reminder can arrive late.',
  parameters: { type: 'object', properties: { text: { type: 'string' }, when: { type: 'string' } }, required: ['text', 'when'] },
  async run({ text, when }, ctx) {
    const due = localToEpoch(String(when), TZ()); if (due === null) throw new Error('when must look like 2026-12-01 09:30');
    if (due < Date.now() - 60_000) throw new Error('that time is in the past');
    const link = await ctx.db.get('SELECT 1 x FROM tg_links WHERE user_id=?', ctx.userId); if (!link) throw new Error('reminders are delivered through Telegram, and this account is not linked to it');
    const n: any = await ctx.db.get("SELECT count(*) c FROM reminders WHERE user_id=? AND status='pending'", ctx.userId); if (Number(n.c) >= 50) throw new Error('too many pending reminders (50)');
    const id = randomUUID(); await ctx.db.run('INSERT INTO reminders(id,user_id,text,due_at,status,created_at) VALUES(?,?,?,?,?,?)', id, ctx.userId, String(text).slice(0, 500), due, 'pending', Date.now());
    return { output: { id, text, due_local: String(when), due_utc: new Date(due).toISOString(), note: 'best effort delivery; may be late if the server is asleep' } };
  },
};
const listReminders: Tool = {
  name: 'list_reminders', description: 'List the user\'s pending reminders.', parameters: { type: 'object', properties: {} },
  async run(_a, ctx) { return { output: { reminders: (await ctx.db.all("SELECT id,text,due_at FROM reminders WHERE user_id=? AND status='pending' ORDER BY due_at", ctx.userId) as any[]).map(r => ({ id: r.id, text: r.text, due_local: new Intl.DateTimeFormat('sv-SE', { timeZone: TZ(), dateStyle: 'short', timeStyle: 'short' }).format(new Date(Number(r.due_at))) })) } }; },
};
const cancelReminder: Tool = {
  name: 'cancel_reminder', description: 'Cancel a pending reminder by id (from list_reminders).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async run({ id }, ctx) {
    const r: any = await ctx.db.get("SELECT id FROM reminders WHERE id=? AND user_id=? AND status='pending'", id, ctx.userId); if (!r) throw new Error('reminder not found');
    await ctx.db.run("UPDATE reminders SET status='canceled' WHERE id=?", id); return { output: { canceled: id } };
  },
};
export const TOOLS: Record<string, Tool> = Object.fromEntries([webSearch, webRead, readFile, createDoc, saveMemory, createReminder, listReminders, cancelReminder].map(t => [t.name, t]));

export interface AgentDef { id: string; name: string; instructions: string; tools: string[] }
export const AGENTS: Record<string, AgentDef> = {
  general: { id: 'general', name: 'المساعد الرئيسي', tools: ['web_search', 'web_read', 'read_file', 'create_document', 'save_memory', 'create_reminder', 'list_reminders', 'cancel_reminder'],
    instructions: 'You are Chat Luck, the lead assistant. Pick the right tool when a task needs real information, files or saved preferences; otherwise answer directly.' },
  tasks: { id: 'tasks', name: 'وكيل المهام', tools: ['create_reminder', 'list_reminders', 'cancel_reminder', 'save_memory'],
    instructions: 'You are the Task Management Agent. Create, list and cancel reminders. Always confirm the exact local date and time you set. Reminders are best effort because the server can be asleep; say so.' },
  research: { id: 'research', name: 'وكيل البحث', tools: ['web_search', 'web_read'],
    instructions: 'You are the Research Agent. Search the web, open pages when needed, compare sources and report with source links. Label each claim as confirmed (has a source) or unconfirmed. Never state recent facts, prices or availability without a source.' },
  files: { id: 'files', name: 'وكيل الملفات', tools: ['read_file', 'create_document'],
    instructions: 'You are the Files Agent. Read the user\'s uploaded files, analyse and summarise them, and create real DOCX/XLSX/PPTX/PDF files when asked. Do not claim a file exists unless create_document succeeded.' },
};
export const toolSpecs = (names: string[]): ToolSpec[] => names.map(n => TOOLS[n]).filter(Boolean).map(({ name, description, parameters }) => ({ name, description, parameters }));
