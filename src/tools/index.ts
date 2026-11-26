import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Db } from '../db.ts';
import type { Provider, ToolSpec } from '../providers/types.ts';
import { addMemory, MemoryError } from '../memory.ts';
import { buildApk, testWorkflow, testScript, type CiKind } from './apk.ts';
import { createDocument, verifyDocument, extractText, isImage, extOf, MIME, type DocSpec } from '../files.ts';

export interface ToolCtx { db: Db; userId: string; taskId: string; provider: Provider; model: string; signal: AbortSignal; fetchImpl?: typeof fetch }
export interface Tool extends ToolSpec { needsApproval?: boolean; compactArgs?(args: any): any; run(args: any, ctx: ToolCtx): Promise<{ output: any; verified?: { ok: boolean; detail: string }; fileId?: string }> }

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
    const q = String(query).slice(0, 400);
    if (ctx.provider.search) {
      try {
        const r = await ctx.provider.search(q, ctx.signal);
        if (!r.sources.length) return { output: { answer: r.answer, sources: [], note: 'No sources were returned; treat this as UNCONFIRMED.' } };
        return { output: r };
      } catch { /* quota or unsupported: fall back to plain web search below */ }
    }
    const res = await bingSearch(q, ctx.fetchImpl ?? fetch, ctx.signal);
    if (!res.length) throw new Error('web search returned no results');
    return { output: { note: 'Plain web search results (no AI grounding). Open a result with web_read before stating facts; unverified snippets are UNCONFIRMED.', results: res } };
  },
};
export async function bingSearch(q: string, f: typeof fetch, signal: AbortSignal) {
  const r = await f('https://www.bing.com/search?setlang=en&q=' + encodeURIComponent(q), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('search HTTP ' + r.status);
  const html = await r.text(); const out: { title: string; url: string; snippet: string }[] = [];
  for (const blk of html.split('<li class="b_algo"').slice(1)) {
    const m = blk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/); if (!m) continue;
    let url = m[1].replace(/&amp;/g, '&');
    const u = url.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
    if (u) { try { url = Buffer.from(u[1], 'base64url').toString('utf8'); } catch { continue; } }
    if (!/^https?:\/\//.test(url) || /bing\.com\/ck\//.test(url)) continue;
    const sn = blk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: htmlToText(m[2]).slice(0, 160), url, snippet: sn ? htmlToText(sn[1]).slice(0, 300) : '' });
    if (out.length >= 6) break;
  }
  return out;
}
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

// Drop anything before the XML declaration or first tag: model output often
// prepends prose/blank lines to .xml files, which fails the real build with
// "Content is not allowed in prolog".
export const sanitizeXmlContent = (c: string): string => { let i = c.indexOf('<?xml'); if (i < 0) i = c.indexOf('<'); return i > 0 ? c.slice(i) : c; };
// History compaction placeholder. Weak models copy it into NEW project_write
// calls as real content, corrupting the project; project_write rejects it.
export const HISTORY_OMITTED = '(full file text saved; omitted from history. NEVER copy this string as file content: always send the complete file text)';
export const PLACEHOLDER_CONTENT = /^\s*(\[saved\]|\(full file text saved[^)]*\))\s*$/i;
const SAFE_PATH = (p: string) => typeof p === 'string' && p.length > 0 && p.length <= 200 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(x => x === '..' || x === '' || x === '.') && !/[\x00-\x1f]/.test(p);
const projectWrite: Tool = {
  name: 'project_write', description: 'Save source files into the project being generated (accumulates across calls; same path overwrites). Max 15 files and 60000 chars per file per call. Write COMPLETE files, no placeholders. Paths are relative like app/src/main/AndroidManifest.xml.',
  parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['files'] },
  compactArgs: (a) => ({ files: (a?.files ?? []).map((f: any) => ({ path: f?.path, content: HISTORY_OMITTED })) }),
  async run({ files }, ctx) {
    if (!Array.isArray(files) || !files.length || files.length > 15) throw new Error('send 1 to 15 files per call');
    const tot: any = await ctx.db.get('SELECT count(*) c, COALESCE(sum(length(content)),0) b FROM project_files WHERE task_id=?', ctx.taskId);
    let added = 0;
    for (const f of files) {
      if (!SAFE_PATH(f?.path)) throw new Error('invalid path: ' + String(f?.path).slice(0, 80));
      if (typeof f.content !== 'string' || f.content.length > 60000) throw new Error('bad or too large content for ' + f.path);
      if (PLACEHOLDER_CONTENT.test(f.content)) throw new Error('"' + f.path + '": you sent a history placeholder instead of the file\'s real content. ALWAYS send the COMPLETE file text in project_write, even for files written in earlier calls.');
      added += f.content.length;
    }
    if (Number(tot.c) + files.length > 1000 || Number(tot.b) + added > 6_000_000) throw new Error('project size limit reached (1000 files / 6 MB)');
    for (const f of files) { let c: string = f.content.replace(/^\uFEFF/, ''); const m = c.match(/^\s*```[a-zA-Z0-9]*\r?\n([\s\S]*?)\r?\n?```\s*$/); if (m) c = m[1]; if (/\.xml$/.test(f.path)) { c = sanitizeXmlContent(c); if (!c.startsWith('<')) throw new Error('"' + f.path + '": not valid XML (must start with <?xml or a tag). Send the complete file text.'); } f.content = c; }
    const same: string[] = [];
    for (const f of files) { const ex: any = await ctx.db.get('SELECT content FROM project_files WHERE task_id=? AND path=?', ctx.taskId, f.path); if (ex && ex.content === f.content) same.push(f.path); }
    for (const f of files) { await ctx.db.run('DELETE FROM project_files WHERE task_id=? AND path=?', ctx.taskId, f.path); await ctx.db.run('INSERT INTO project_files(task_id,path,content) VALUES(?,?,?)', ctx.taskId, f.path, f.content); }
    const n: any = await ctx.db.get('SELECT count(*) c FROM project_files WHERE task_id=?', ctx.taskId);
    const all = await ctx.db.all('SELECT path FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    const plan = await planProgress(ctx);
    return { output: { saved: files.map((f: any) => f.path), total_files: Number(n.c), plan: plan ? { missing_total: plan.missing_total, current_stage: plan.current_stage, write_next: plan.write_next } : undefined, already_identical: same.length ? same : undefined, all_paths_so_far: all.slice(0, 300).map(r => r.path), next: same.length ? 'These files were already saved with identical content: rewriting the same text cannot fix a failed build. If a build/check failed, read the exact error, call project_read on the file, and change something DIFFERENT (or fix the real culprit in another file). Do NOT rewrite them unchanged. Write only files that are still missing, then call build_apk.' : 'Write only the files still missing from your plan (see all_paths_so_far), then call build_apk. Never rewrite a file that is already listed.' } };
  },
};
async function planProgress(ctx: ToolCtx) {
  const r: any = await ctx.db.get('SELECT plan FROM project_plan WHERE task_id=?', ctx.taskId); if (!r) return null;
  const plan = JSON.parse(r.plan) as { name: string; stages: { title: string; files: string[] }[] };
  const have = new Set(((await ctx.db.all('SELECT path FROM project_files WHERE task_id=?', ctx.taskId)) as any[]).map(x => x.path));
  const stages = plan.stages.map(st => ({ title: st.title, missing: st.files.filter(f => !have.has(f)), total: st.files.length }));
  const cur = stages.find(st => st.missing.length);
  return { name: plan.name, stages, missing_total: stages.reduce((a, b) => a + b.missing.length, 0), current_stage: cur ? cur.title : null, write_next: cur ? cur.missing.slice(0, 8) : [] };
}
const projectPlan: Tool = {
  name: 'project_plan', description: 'For any project of more than ~12 files: save the build plan FIRST as stages (e.g. 1 gradle/config, 2 data layer, 3 screens...), each stage listing the exact file paths (6-10 files per stage, max 12 stages, max 300 files). Afterwards write stage by stage; project_write reports what is still missing. Call again to revise the plan.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, stages: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['title', 'files'] } } }, required: ['name', 'stages'] },
  async run({ name, stages }, ctx) {
    if (!Array.isArray(stages) || !stages.length || stages.length > 12) throw new Error('1 to 12 stages');
    const all = stages.flatMap((x: any) => x?.files ?? []); if (all.length > 300) throw new Error('max 300 files in a plan');
    for (const f of all) if (!SAFE_PATH(f)) throw new Error('invalid path in plan: ' + String(f).slice(0, 80));
    await ctx.db.run('DELETE FROM project_plan WHERE task_id=?', ctx.taskId);
    await ctx.db.run('INSERT INTO project_plan(task_id,plan) VALUES(?,?)', ctx.taskId, JSON.stringify({ name: String(name).slice(0, 80), stages: stages.map((x: any) => ({ title: String(x.title).slice(0, 80), files: x.files })) }));
    return { output: { saved: true, stages: stages.length, files_planned: all.length, next: 'Write stage 1 now with project_write (6-8 files per call), then project_check, then the next stage.' } };
  },
};
export function checkProject(rows: { path: string; content: string }[]) {
  const issues: string[] = []; const byPath = new Map(rows.map(r => [r.path, r.content]));
  // XML well-formedness and JSON validity
  for (const r of rows) {
    if (/\.xml$/i.test(r.path)) {
      const src = r.content.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, ''); const stack: string[] = [];
      for (const m of src.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
        if (m[4]) continue; if (!m[1]) stack.push(m[2]); else { const top = stack.pop(); if (top !== m[2]) { issues.push(`${r.path}: XML tag mismatch (</${m[2]}> closes <${top ?? 'nothing'}>)`); break; } }
      }
      if (stack.length && !issues.some(i => i.startsWith(r.path))) issues.push(`${r.path}: unclosed XML tag <${stack[stack.length - 1]}>`);
    }
    if (/\.json$/i.test(r.path)) { try { JSON.parse(r.content); } catch (e: any) { issues.push(`${r.path}: invalid JSON (${String(e.message).slice(0, 60)})`); } }
  }
  // Kotlin/Java: package vs path, internal imports, declared names
  const src = rows.filter(r => /\.(kt|java)$/.test(r.path)); const decl = new Map<string, Set<string>>();
  for (const r of src) {
    const pk = r.content.match(/^\s*package\s+([\w.]+)/m)?.[1]; const m = r.path.match(/(?:java|kotlin)\/(.+)\/[^/]+$/);
    if (pk && m && pk !== m[1].replace(/\//g, '.')) issues.push(`${r.path}: package ${pk} does not match its folder ${m[1].replace(/\//g, '.')}`);
    if (pk) { const set = decl.get(pk) ?? new Set<string>(); for (const d of r.content.matchAll(/\b(?:class|object|interface|typealias|fun|val|var)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/g)) set.add(d[1]); decl.set(pk, set); }
  }
  const pkgs = [...decl.keys()]; const root = pkgs.length ? pkgs.sort((a, b) => a.length - b.length)[0] : '';
  const rootTwo = root.split('.').slice(0, 3).join('.');
  for (const r of src) for (const im of r.content.matchAll(/^\s*import\s+([\w.]+?)(\.\*)?\s*$/gm)) {
    const full = im[1]; if (!root || !full.startsWith(rootTwo)) continue;
    if (im[2]) { if (!pkgs.some(p => p === full || p.startsWith(full + '.'))) issues.push(`${r.path}: wildcard import ${full}.* matches no package`); continue; }
    const parts = full.split('.'); const name = parts.pop()!; const pk = parts.join('.');
    if (name === 'R' || name === 'BuildConfig') continue;
    if (!decl.get(pk)?.has(name)) { const outer = pk.split('.'); const nested = outer.pop(); if (!(nested && decl.get(outer.join('.'))?.has(nested))) issues.push(`${r.path}: import ${full} not found in the project`); }
  }
  // Resources
  const defs: Record<string, Set<string>> = { string: new Set(), color: new Set(), style: new Set(), dimen: new Set(), layout: new Set(), drawable: new Set(), mipmap: new Set() };
  for (const r of rows) {
    if (/res\/values[^/]*\/.+\.xml$/.test(r.path)) for (const d of r.content.matchAll(/<(string|color|style|dimen|drawable)\s+name="([\w.]+)"/g)) { (defs[d[1]] ??= new Set()).add(d[2].replace(/\./g, '_')); }
    const f = r.path.match(/res\/(layout|drawable|mipmap)[^/]*\/([\w]+)\.\w+$/); if (f) defs[f[1]].add(f[2]);
  }
  const hasRes = Object.values(defs).some(s => s.size);
  if (hasRes) for (const r of rows) {
    if (!/\.(kt|java|xml)$/.test(r.path)) continue;
    const refs = [...r.content.matchAll(/\bR\.(string|color|layout|drawable|mipmap)\.(\w+)/g)].map(m => [m[1], m[2]]).concat([...r.content.matchAll(/@(string|color|layout|drawable|mipmap)\/(\w+)/g)].map(m => [m[1], m[2]]));
    for (const [k, n] of refs) { if (/^(kt|java)$/.test(r.path.split('.').pop() ?? '') || true) if (!defs[k].has(n.replace(/\./g, '_'))) { const msg = `${r.path}: resource ${k}/${n} is referenced but not defined`; if (!issues.includes(msg)) issues.push(msg); } }
  }
  // Manifest activities
  const man = byPath.get('app/src/main/AndroidManifest.xml');
  if (man) for (const a of man.matchAll(/<(?:activity|service|receiver)[^>]*android:name="([^"]+)"/g)) {
    const n = a[1].split('.').pop()!; if (!/^(androidx|android|com\.google)/.test(a[1]) && !src.some(r => new RegExp(`\\b(class|object)\\s+${n}\\b`).test(r.content))) issues.push(`AndroidManifest.xml: ${a[1]} has no matching class in the project`);
  }
  return issues.slice(0, 60);
}
const projectCheck: Tool = {
  name: 'project_check', description: 'Fast local consistency check of the saved project (no CI): planned files missing, malformed XML/JSON, Kotlin/Java package vs folder, internal imports that do not resolve, undefined @string/@layout/@drawable/R.* resources, manifest classes missing. Run it after every stage and fix all issues before continuing. It does NOT replace run_tests/build_apk.',
  parameters: { type: 'object', properties: {} },
  async run(_a, ctx) {
    const rows = await ctx.db.all('SELECT path, content FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[]; if (!rows.length) throw new Error('no project files saved yet');
    const issues = checkProject(rows); const pr = await planProgress(ctx); if (pr?.missing_total) issues.unshift(`${pr.missing_total} planned files are still missing (stage "${pr.current_stage}"): ${pr.write_next.join(', ')}`);
    return { output: { ok: !issues.length, issues, files: rows.length, progress: pr ? { missing_total: pr.missing_total, current_stage: pr.current_stage } : undefined }, verified: { ok: !issues.length, detail: issues.length ? `فحص محلي: ${issues.length} مشكلة` : `فحص محلي: ${rows.length} ملف متسق` } };
  },
};
const projectStatus: Tool = {
  name: 'project_status', description: 'List the file paths saved so far in the project.', parameters: { type: 'object', properties: {} },
  async run(_a, ctx) {
    const rows = await ctx.db.all('SELECT path, length(content) len FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    return { output: { total_files: rows.length, files: rows.slice(0, 400).map(r => r.path + ' (' + r.len + ')') } };
  },
};
const ANDROID_REQUIRED: [string, RegExp][] = [['settings.gradle(.kts)', /^settings\.gradle(\.kts)?$/], ['gradle.properties', /^gradle\.properties$/], ['gradle/wrapper/gradle-wrapper.properties', /^gradle\/wrapper\/gradle-wrapper\.properties$/], ['app/src/main/res/values (strings or themes)', /^app\/src\/main\/res\/values\/.+\.xml$/], ['root build.gradle(.kts)', /^build\.gradle(\.kts)?$/], ['app/build.gradle(.kts)', /^app\/build\.gradle(\.kts)?$/], ['app/src/main/AndroidManifest.xml', /^app\/src\/main\/AndroidManifest\.xml$/], ['a .kt or .java source file', /\.(kt|java)$/]];
const projectZip: Tool = {
  name: 'project_zip', description: 'Package all saved project files into a downloadable .zip and verify it by re-opening it. Use kind "android" for an Android Studio project (checks the required Gradle/manifest/source files).',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'zip file name, e.g. MyApp.zip' }, kind: { type: 'string', enum: ['android', 'generic'] }, deliver_unverified: { type: 'boolean', description: 'Only after at least 3 real fix attempts failed: delivers a zip clearly labelled UNVERIFIED.' } }, required: ['name'] },
  async run({ name, kind, deliver_unverified }, ctx) {
    const rows = await ctx.db.all('SELECT path, content FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    if (!rows.length) throw new Error('no project files saved yet');
    // delivery gate: code is only handed over after a real passing test/build that ran AFTER the last edit
    const lw: any = await ctx.db.get("SELECT max(idx) i FROM task_steps WHERE task_id=? AND tool='project_write' AND kind='tool' AND status='ok'", ctx.taskId);
    const lv: any = await ctx.db.get("SELECT max(idx) i FROM task_steps WHERE task_id=? AND kind='verify' AND tool IN ('run_tests','build_apk') AND status='ok'", ctx.taskId);
    const fails: any = await ctx.db.get("SELECT count(*) c FROM task_steps WHERE task_id=? AND kind='verify' AND tool IN ('run_tests','build_apk') AND status='failed'", ctx.taskId);
    const verifiedOk = lv?.i != null && (lw?.i == null || Number(lv.i) > Number(lw.i));
    if (!verifiedOk && !(deliver_unverified && Number(fails.c) >= 3)) throw new Error('NOT VERIFIED: no passing run_tests/build_apk after the last edit. Run run_tests (or build_apk for Android), read the errors, fix the files, and repeat until it passes. Only after 3 failed fix attempts may you set deliver_unverified=true.');
    const unverified = !verifiedOk;
    if (kind === 'android') {
      const missing = ANDROID_REQUIRED.filter(([, re]) => !rows.some(r => re.test(r.path))).map(([n]) => n);
      if (missing.length) throw new Error('Android project is missing: ' + missing.join(', '));
    }
    const JSZip: any = (await import('jszip')).default; const z = new JSZip();
    for (const r of rows) z.file(r.path, r.content);
    const buf: Buffer = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const back = await JSZip.loadAsync(buf); const names = Object.keys(back.files).filter((n: string) => !back.files[n].dir);
    let same = names.length === rows.length;
    for (const r of rows) { const f = back.file(r.path); if (!f || (await f.async('string')) !== r.content) { same = false; break; } }
    if (!same) throw new Error('zip verification failed (file count or content mismatch)');
    const fname = String(name || 'project.zip').replace(/[^\w.\-]/g, '_').replace(/(\.zip)?$/i, unverified ? '-UNVERIFIED.zip' : '.zip').slice(0, 80);
    if (buf.length > 20 * 1024 * 1024) throw new Error('zip is larger than 20 MB');
    const id = randomUUID();
    await ctx.db.run('INSERT INTO files(id,user_id,name,mime,size,origin,text,data,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ctx.userId, fname, 'application/zip', buf.length, 'generated', null, buf.toString('base64'), ctx.taskId, Date.now());
    return { output: { file_id: id, name: fname, size: buf.length, files: rows.length }, verified: { ok: !unverified, detail: (unverified ? 'تحذير: هذا المشروع لم يجتز الاختبارات (غير متحقق منه). ' : 'اجتاز اختبار/بناء حقيقي بعد آخر تعديل. ') + `أعيد فتح الملف المضغوط: ${rows.length} ملف مطابقة للمحتوى` + (kind === 'android' ? ' وهيكل Android الأساسي موجود' : '') }, fileId: id };
  },
};

async function saveGenerated(ctx: ToolCtx, name: string, mime: string, buf: Buffer) {
  const id = randomUUID();
  await ctx.db.run('INSERT INTO files(id,user_id,name,mime,size,origin,text,data,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ctx.userId, name, mime, buf.length, 'generated', null, buf.toString('base64'), ctx.taskId, Date.now());
  return id;
}
const buildApkTool: Tool = {
  name: 'build_apk', description: 'Compile the saved Android project for real on GitHub Actions (free) and return the debug APK file. Takes 3-8 minutes. If the build fails you get the compiler error lines: fix the files with project_write and call build_apk again (up to 3 attempts). The project must follow the standard Android Studio layout (Gradle 8.7, AGP 8.5.2, Kotlin 1.9.24, compileSdk 34). The build repo is public, so never include secrets.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'APK file name, e.g. MyApp.apk' } }, required: ['name'] },
  async run({ name }, ctx) {
    const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_BUILD_REPO;
    if (!token || !repo) throw new Error('بناء APK غير مفعّل على هذا الخادم (GITHUB_TOKEN/GITHUB_BUILD_REPO غير مضبوطين)');
    const rows = await ctx.db.all('SELECT path, content FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    if (!rows.length) throw new Error('no project files saved yet');
    const missing = ANDROID_REQUIRED.filter(([, re]) => !rows.some(r => re.test(r.path))).map(([n]) => n);
    if (missing.length) throw new Error('Android project is missing: ' + missing.join(', '));
    const res = await buildApk({ token, repo, files: rows, fetchImpl: ctx.fetchImpl, signal: ctx.signal, id: ctx.taskId.replace(/[^\w]/g, '').slice(0, 12) + '-' + Date.now().toString(36) });
    if (!res.ok) return { output: { built: false, note: res.note, errors: res.errorLines, run: res.runUrl }, verified: { ok: false, detail: 'فشل بناء APK: ' + (res.note ?? '') } };
    const fname = String(name || res.apkName || 'app.apk').replace(/[^\w.\-]/g, '_').replace(/(\.apk)?$/i, '.apk').slice(0, 80);
    const id = await saveGenerated(ctx, fname, 'application/vnd.android.package-archive', res.apk!);
    return { output: { built: true, file_id: id, name: fname, size: res.apk!.length, run: res.runUrl, note: 'debug-signed APK for sideloading' }, verified: { ok: true, detail: `تم بناء APK فعليًا عبر GitHub Actions (${Math.round(res.apk!.length / 1024)} KB)` }, fileId: id };
  },
};
const runTests: Tool = {
  name: 'run_tests', description: 'Really run the saved project\'s tests (or any build/check command) on GitHub Actions (free, isolated, no secrets, 15 min limit) and return the real output. kind: node, python, android (gradle unit tests), web, custom. Optional command overrides the default (bash lines, e.g. "npm ci && npm test"). If tests fail you get the error lines: fix the files with project_write and run again. Never claim tests passed unless this returns passed:true.',
  parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['node', 'python', 'android', 'web', 'custom'] }, command: { type: 'string' } }, required: ['kind'] },
  async run({ kind, command }, ctx) {
    const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_BUILD_REPO;
    if (!token || !repo) throw new Error('تشغيل الاختبارات غير مفعّل على هذا الخادم');
    if (!['node', 'python', 'android', 'web', 'custom'].includes(kind)) throw new Error('bad kind');
    if (String(command ?? '').length > 2000) throw new Error('command too long');
    const rows = await ctx.db.all('SELECT path, content FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    if (!rows.length) throw new Error('no project files saved yet');
    const files = rows.filter(r => !r.path.startsWith('.ci/')).concat([{ path: '.ci/run.sh', content: testScript(kind as CiKind, command) }]);
    const res = await buildApk({ token, repo, files, apk: false, workflow: testWorkflow(kind as CiKind), fetchImpl: ctx.fetchImpl, signal: ctx.signal, maxWaitMs: 9 * 60000, id: 't-' + ctx.taskId.replace(/[^\w]/g, '').slice(0, 10) + '-' + Date.now().toString(36) });
    const out = { passed: res.ok, run: res.runUrl, output_tail: res.logTail, errors: res.ok ? undefined : res.errorLines, note: res.note };
    return { output: out, verified: { ok: res.ok, detail: res.ok ? 'اجتازت الاختبارات فعليًا على GitHub Actions' : 'فشلت الاختبارات أو الأمر: ' + (res.note ?? '') } };
  },
};
const TEXT_EXT = /\.(kt|kts|java|xml|gradle|properties|pro|md|txt|json|ya?ml|toml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|sql|sh|env\.example|gitignore|cfg|ini|csv|svg|c|h|cpp|go|rs|php|rb|swift|dart|vue)$/i;
const projectLoad: Tool = {
  name: 'project_load', description: 'Load an uploaded or previously generated .zip (by file_id) into the project workspace so you can read, edit, test and re-package it. Binary files are skipped and listed. The original file is never modified: results are saved as a new zip.',
  parameters: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'] },
  async run({ file_id }, ctx) {
    const f: any = await ctx.db.get('SELECT name,data FROM files WHERE id=? AND user_id=?', file_id, ctx.userId); if (!f) throw new Error('file not found');
    if (!/\.zip$/i.test(f.name)) throw new Error('only .zip files can be loaded');
    const JSZip: any = (await import('jszip')).default; const z = await JSZip.loadAsync(Buffer.from(f.data, 'base64'));
    const names = Object.keys(z.files).filter(n => !z.files[n].dir); if (names.length > 1000) throw new Error('zip has more than 1000 files');
    const skipped: string[] = []; let loaded = 0, bytes = 0;
    for (const n of names) {
      const clean = n.replace(/^\.?\//, ''); const top = clean.split('/')[0];
      if (!SAFE_PATH(clean) || /(^|\/)(node_modules|\.git|build|\.gradle)\//.test(clean) || !TEXT_EXT.test(clean)) { skipped.push(clean); continue; }
      const c: string = await z.files[n].async('string'); if (c.length > 60000 || c.includes('\u0000')) { skipped.push(clean); continue; }
      bytes += c.length; if (bytes > 6_000_000) { skipped.push(clean); continue; }
      await ctx.db.run('DELETE FROM project_files WHERE task_id=? AND path=?', ctx.taskId, clean); await ctx.db.run('INSERT INTO project_files(task_id,path,content) VALUES(?,?,?)', ctx.taskId, clean, c); loaded++; void top;
    }
    return { output: { loaded, skipped_count: skipped.length, skipped_sample: skipped.slice(0, 30), note: 'Use project_read to view files, project_write to change them, run_tests / build_apk to verify, project_zip to export a NEW zip.' } };
  },
};
const projectRead: Tool = {
  name: 'project_read', description: 'Read saved project files. With no path: list all paths. With path: return that file content (up to 12000 chars; use offset for more).',
  parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } } },
  async run({ path, offset }, ctx) {
    if (!path) { const rows = await ctx.db.all('SELECT path,length(content) len FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[]; return { output: { total: rows.length, files: rows.slice(0, 500).map(r => r.path + ' (' + r.len + ')') } }; }
    const r: any = await ctx.db.get('SELECT content FROM project_files WHERE task_id=? AND path=?', ctx.taskId, String(path)); if (!r) throw new Error('file not found in project');
    const o = Math.max(0, Number(offset) || 0); return { output: { path, length: r.content.length, offset: o, content: r.content.slice(o, o + 12000), more: r.content.length > o + 12000 } };
  },
};
const generateImage: Tool = {
  name: 'generate_image', description: 'Generate a new image from a text prompt (free services, no key: Pollinations, then Stable Horde). Write the prompt in English for best results (translate Arabic requests). Returns a file the user receives.',
  parameters: { type: 'object', properties: { prompt: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, seed: { type: 'integer' } }, required: ['prompt'] },
  async run({ prompt, width, height, seed }, ctx) {
    const w = Math.min(1536, Math.max(256, Number(width) || 1024)), h = Math.min(1536, Math.max(256, Number(height) || 1024)); let used = '';
    const f = ctx.fetchImpl ?? fetch; const text = String(prompt).slice(0, 800); const sd = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 1e6);
    const sig = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(60000)]);
    const grab = async (url: string) => { const r = await f(url, { signal: sig() }); if (!r.ok) throw new Error('HTTP ' + r.status); const b = Buffer.from(await r.arrayBuffer()); if (b.length < 1000) throw new Error('empty image'); return b; };
    const providers: [string, () => Promise<Buffer>][] = [
      ['pollinations', () => grab(`https://gen.pollinations.ai/image/${encodeURIComponent(text)}?width=${w}&height=${h}&nologo=true&seed=${sd}`)],
      ['pollinations-legacy', () => grab(`https://image.pollinations.ai/prompt/${encodeURIComponent(text)}?width=${w}&height=${h}&nologo=true&seed=${sd}`)],
      ['stablehorde', async () => { // free anonymous community GPU network; queue time varies
        const hw = Math.min(768, Math.round(w / 64) * 64), hh = Math.min(768, Math.round(h / 64) * 64);
        const hdr = { 'content-type': 'application/json', apikey: '0000000000', 'client-agent': 'chatluck:1.0:anon' };
        const r = await f('https://stablehorde.net/api/v2/generate/async', { method: 'POST', headers: hdr, signal: sig(), body: JSON.stringify({ prompt: text, params: { width: hw, height: hh, steps: 25, n: 1 }, nsfw: false, censor_nsfw: true, r2: true }) });
        const j: any = await r.json().catch(() => ({})); if (!j.id) throw new Error('horde: ' + (j.message ?? r.status));
        for (let i = 0; i < 20; i++) {
          await new Promise(res => setTimeout(res, 4000)); if (ctx.signal.aborted) throw new Error('canceled');
          const c: any = await (await f(`https://stablehorde.net/api/v2/generate/check/${j.id}`, { signal: sig() })).json().catch(() => ({}));
          if (c.faulted) throw new Error('horde faulted'); if (c.done) break;
          if (i === 19) throw new Error('horde queue too long');
        }
        const st: any = await (await f(`https://stablehorde.net/api/v2/generate/status/${j.id}`, { signal: sig() })).json();
        const img = st.generations?.[0]?.img; if (!img) throw new Error('horde returned no image');
        return grab(img);
      }],
    ];
    let buf: Buffer | undefined; const errs: string[] = [];
    for (const [name, fn] of providers) { try { buf = await fn(); if (buf) { used = name; break; } } catch (e: any) { errs.push(name + ': ' + String(e?.message ?? e).slice(0, 60)); } }
    if (!buf) throw new Error('all free image services failed (' + errs.join('; ') + ')');
    const sharp: any = (await import('sharp')).default; const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error('generated file is not a valid image');
    const ext = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpg'; const name = 'image_' + Date.now() + '.' + ext;
    const id = await saveGenerated(ctx, name, ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', buf);
    return { output: { file_id: id, name, width: meta.width, height: meta.height, provider: used, note: 'Generated by a free third-party image service (the prompt is sent to it).' }, verified: { ok: true, detail: `الصورة فُتحت وتم التحقق منها (${meta.width}x${meta.height})` }, fileId: id };
  },
};
const editImage: Tool = {
  name: 'edit_image', description: 'Edit or enhance an uploaded/generated image with real image processing (not AI). ops is an ordered list. Supported: {op:"resize",width,height}, {op:"crop",left,top,width,height}, {op:"rotate",degrees}, {op:"flip"}, {op:"flop"}, {op:"grayscale"}, {op:"brightness",value(0.5-2)}, {op:"saturation",value(0-3)}, {op:"contrast",value(0.5-2)}, {op:"sharpen"}, {op:"denoise"}, {op:"blur",sigma}, {op:"enhance"} (auto levels + mild sharpen + slight color boost), {op:"upscale",factor(2 or 3)} (Lanczos resize plus sharpen, not AI super-resolution), {op:"format",type:"png|jpeg|webp"}. Output is a new file.',
  parameters: { type: 'object', properties: { file_id: { type: 'string' }, ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] } } }, required: ['file_id', 'ops'] },
  async run({ file_id, ops }, ctx) {
    const f: any = await ctx.db.get('SELECT * FROM files WHERE id=? AND user_id=?', file_id, ctx.userId);
    if (!f || !isImage(f.name)) throw new Error('image file not found');
    if (!Array.isArray(ops) || !ops.length || ops.length > 12) throw new Error('give 1 to 12 ops');
    const sharp: any = (await import('sharp')).default;
    let img = sharp(Buffer.from(f.data, 'base64'), { limitInputPixels: 50_000_000 }).rotate(); let fmt = 'png'; let src = await img.metadata();
    const done: string[] = [];
    for (const o of ops) {
      const n = (v: any, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
      switch (o.op) {
        case 'resize': img = img.resize({ width: o.width ? Math.round(n(o.width, 1, 6000, 0)) : undefined, height: o.height ? Math.round(n(o.height, 1, 6000, 0)) : undefined, fit: 'inside', withoutEnlargement: false }); break;
        case 'crop': img = img.extract({ left: Math.round(n(o.left, 0, 20000, 0)), top: Math.round(n(o.top, 0, 20000, 0)), width: Math.round(n(o.width, 1, 20000, 1)), height: Math.round(n(o.height, 1, 20000, 1)) }); break;
        case 'rotate': img = img.rotate(n(o.degrees, -360, 360, 90)); break;
        case 'flip': img = img.flip(); break; case 'flop': img = img.flop(); break;
        case 'grayscale': img = img.grayscale(); break;
        case 'brightness': img = img.modulate({ brightness: n(o.value, 0.3, 3, 1) }); break;
        case 'saturation': img = img.modulate({ saturation: n(o.value, 0, 3, 1) }); break;
        case 'contrast': { const a = n(o.value, 0.5, 2, 1); img = img.linear(a, 128 * (1 - a)); break; }
        case 'sharpen': img = img.sharpen(); break;
        case 'denoise': img = img.median(3); break;
        case 'blur': img = img.blur(n(o.sigma, 0.3, 50, 2)); break;
        case 'enhance': img = img.normalise().modulate({ saturation: 1.1 }).sharpen({ sigma: 1 }); break;
        case 'upscale': { const k = n(o.factor, 2, 3, 2); const w = Math.round((src.width ?? 512) * k); if (w > 6000) throw new Error('result too large'); img = img.resize({ width: w, kernel: 'lanczos3' }).sharpen({ sigma: 1.2 }); break; }
        case 'format': { const t = String(o.type).toLowerCase(); if (!['png', 'jpeg', 'jpg', 'webp'].includes(t)) throw new Error('unsupported format'); fmt = t === 'jpg' ? 'jpeg' : t; break; }
        default: throw new Error('unsupported op: ' + String(o.op).slice(0, 30));
      }
      done.push(o.op);
      if (['resize', 'crop', 'rotate', 'upscale'].includes(o.op)) { const b = await img.toBuffer(); img = sharp(b); src = await img.metadata(); }
    }
    const out: Buffer = await (fmt === 'jpeg' ? img.jpeg({ quality: 92 }) : fmt === 'webp' ? img.webp({ quality: 92 }) : img.png()).toBuffer();
    const meta = await sharp(out).metadata(); if (!meta.width) throw new Error('result is not a valid image');
    const ext = fmt === 'jpeg' ? 'jpg' : fmt; const name = f.name.replace(/\.[^.]+$/, '') + '_edited.' + ext;
    const id = await saveGenerated(ctx, name, 'image/' + fmt, out);
    return { output: { file_id: id, name, width: meta.width, height: meta.height, applied: done }, verified: { ok: true, detail: `الصورة المعدلة فُتحت وتم التحقق منها (${meta.width}x${meta.height}): ${done.join(', ')}` }, fileId: id };
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
export const TOOLS: Record<string, Tool> = Object.fromEntries([webSearch, webRead, readFile, createDoc, generateImage, editImage, projectWrite, projectStatus, projectPlan, projectCheck, projectZip, buildApkTool, runTests, projectLoad, projectRead, saveMemory, createReminder, listReminders, cancelReminder].map(t => [t.name, t]));

export interface AgentDef { id: string; name: string; instructions: string; tools: string[]; maxIter?: number }
export const AGENTS: Record<string, AgentDef> = {
  general: { id: 'general', name: 'المساعد الرئيسي', tools: ['web_search', 'web_read', 'read_file', 'create_document', 'generate_image', 'edit_image', 'save_memory', 'create_reminder', 'list_reminders', 'cancel_reminder'],
    instructions: 'You are Chat Luck, the lead assistant. Pick the right tool when a task needs real information, files, images or saved preferences; otherwise answer directly. Requests for a picture, design, logo, poster or illustration: call generate_image right away with an English prompt. Attached picture to enhance/resize/crop/convert: call edit_image.' },
  tasks: { id: 'tasks', name: 'وكيل المهام', tools: ['create_reminder', 'list_reminders', 'cancel_reminder', 'save_memory'],
    instructions: 'You are the Task Management Agent. Create, list and cancel reminders. Always confirm the exact local date and time you set. Reminders are best effort because the server can be asleep; say so.' },
  research: { id: 'research', name: 'وكيل البحث', tools: ['web_search', 'web_read'],
    instructions: 'You are the Research Agent. Search the web, open pages when needed, compare sources and report with source links. Label each claim as confirmed (has a source) or unconfirmed. Never state recent facts, prices or availability without a source.' },
  dev: { id: 'dev', name: 'وكيل البرمجة', maxIter: 300, tools: ['project_plan', 'project_check', 'project_write', 'project_status', 'project_read', 'project_load', 'project_zip', 'build_apk', 'run_tests', 'web_search', 'web_read'],
    instructions: 'You are the Software Project Agent. You generate real multi-file source projects, and for Android you produce a project that opens and builds in Android Studio AND a real APK. Method: 1) write a short plan with the full file tree, 2) save files with project_write in batches of at most 12 files, each file COMPLETE and consistent with the others (package names, imports, resource ids, manifest entries), no TODO placeholders, 3) project_status to check nothing is missing, 4) for Android call build_apk (real compile on GitHub Actions, 3-8 minutes). If it fails you receive the compiler errors: fix the exact files with project_write and call build_apk again, up to 3 attempts. After a successful build also call project_zip with kind android so the user gets the source too. STANDARD ANDROID STUDIO LAYOUT (mandatory): settings.gradle.kts (pluginManagement and dependencyResolutionManagement with google() and mavenCentral(), rootProject.name, include(":app")); root build.gradle.kts with plugins { id("com.android.application") version "8.5.2" apply false; id("org.jetbrains.kotlin.android") version "1.9.24" apply false }; gradle.properties (android.useAndroidX=true, org.gradle.jvmargs=-Xmx2048m, kotlin.code.style=official, android.nonTransitiveRClass=true); gradle/wrapper/gradle-wrapper.properties with distributionUrl https://services.gradle.org/distributions/gradle-8.7-bin.zip; app/build.gradle.kts (namespace, compileSdk 34, defaultConfig applicationId/minSdk 24/targetSdk 34/versionCode 1/versionName "1.0", compileOptions and kotlinOptions jvmTarget 17, dependencies androidx.core:core-ktx:1.13.1, androidx.appcompat:appcompat:1.7.0, com.google.android.material:material:1.12.0, androidx.constraintlayout:constraintlayout:2.1.4 as needed); app/proguard-rules.pro; app/src/main/AndroidManifest.xml (exported=true on the launcher activity, android:icon and android:label); app/src/main/res/values/strings.xml, themes.xml (Theme.Material3 or Theme.MaterialComponents parent that exists in the dependencies); a launcher icon as XML drawables (res/drawable/ic_launcher_foreground.xml plus res/mipmap-anydpi-v26/ic_launcher.xml adaptive icon with a color background), no PNG; .gitignore; README.md explaining: open the folder in Android Studio, let Gradle sync, press Run (Android Studio regenerates the wrapper jar and gradlew from gradle-wrapper.properties). Do not include binary files. Prefer simple, robust code (View-based or plain Compose only if you add all Compose config correctly). LARGE PROJECTS (more than 12 files): first call project_plan with stages and exact file paths (6-10 files per stage); then for each stage: project_write the stage files (max 8 per call), then project_check and fix every issue it lists, before moving on; never rewrite a file that is already saved; when all stages are written run build_apk or run_tests and fix until green. ENGINEERING MODE: if the user attached a .zip (see Attached files with file_id), call project_load first, then project_read the relevant files before changing them; never guess file contents. Websites: plain HTML/CSS/JS or a small node project, then run_tests kind web. Backend: node or python with real tests, then run_tests kind node/python and fix failures until they pass or you run out of attempts (max 3 fix rounds). Android: write unit tests when asked and run_tests kind android, then build_apk. DELIVERY RULE: project_zip is refused until run_tests/build_apk passed after your last edit, so ALWAYS verify (compile/run/test) and fix until it passes before exporting; only after 3 failed fix attempts may you use deliver_unverified and you must say clearly that it failed verification and why. Always run tests after significant edits, show the real results, and never invent results. Never overwrite the original zip: export with project_zip as a new file. Do not publish or upload anywhere. End with a report using these labels: project name, task type, files created, files modified, errors found, errors fixed, tests run, test results, build status, files ready, remaining issues, and a final status (COMPLETED, FAILED or PARTIALLY COMPLETED). Never claim the project builds unless build_apk returned built:true; the APK is debug-signed for sideloading (user must allow installs from this source), not Play Store ready. Never put secrets in files: the build repo is public. In your final answer give a short summary, the file count, the APK result, and the honest limits.' },
  files: { id: 'files', name: 'وكيل الملفات', tools: ['read_file', 'create_document', 'generate_image', 'edit_image'],
    instructions: 'You are the Files Agent. Read the user\'s uploaded files, analyse and summarise them, and create real DOCX/XLSX/PPTX/PDF files when asked. Do not claim a file exists unless create_document succeeded.' },
};
export const toolSpecs = (names: string[]): ToolSpec[] => names.map(n => TOOLS[n]).filter(Boolean).map(({ name, description, parameters }) => ({ name, description, parameters }));
