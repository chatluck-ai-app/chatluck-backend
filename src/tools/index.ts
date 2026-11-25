import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Db } from '../db.ts';
import type { Provider, ToolSpec } from '../providers/types.ts';
import { addMemory, MemoryError } from '../memory.ts';
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

const SAFE_PATH = (p: string) => typeof p === 'string' && p.length > 0 && p.length <= 200 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(x => x === '..' || x === '' || x === '.') && !/[\x00-\x1f]/.test(p);
const projectWrite: Tool = {
  name: 'project_write', description: 'Save source files into the project being generated (accumulates across calls; same path overwrites). Max 15 files and 60000 chars per file per call. Write COMPLETE files, no placeholders. Paths are relative like app/src/main/AndroidManifest.xml.',
  parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['files'] },
  compactArgs: (a) => ({ files: (a?.files ?? []).map((f: any) => ({ path: f?.path, content: '[saved]' })) }),
  async run({ files }, ctx) {
    if (!Array.isArray(files) || !files.length || files.length > 15) throw new Error('send 1 to 15 files per call');
    const tot: any = await ctx.db.get('SELECT count(*) c, COALESCE(sum(length(content)),0) b FROM project_files WHERE task_id=?', ctx.taskId);
    let added = 0;
    for (const f of files) {
      if (!SAFE_PATH(f?.path)) throw new Error('invalid path: ' + String(f?.path).slice(0, 80));
      if (typeof f.content !== 'string' || f.content.length > 60000) throw new Error('bad or too large content for ' + f.path);
      added += f.content.length;
    }
    if (Number(tot.c) + files.length > 1000 || Number(tot.b) + added > 6_000_000) throw new Error('project size limit reached (1000 files / 6 MB)');
    for (const f of files) { await ctx.db.run('DELETE FROM project_files WHERE task_id=? AND path=?', ctx.taskId, f.path); await ctx.db.run('INSERT INTO project_files(task_id,path,content) VALUES(?,?,?)', ctx.taskId, f.path, f.content); }
    const n: any = await ctx.db.get('SELECT count(*) c FROM project_files WHERE task_id=?', ctx.taskId);
    return { output: { saved: files.length, total_files: Number(n.c) } };
  },
};
const projectStatus: Tool = {
  name: 'project_status', description: 'List the file paths saved so far in the project.', parameters: { type: 'object', properties: {} },
  async run(_a, ctx) {
    const rows = await ctx.db.all('SELECT path, length(content) len FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    return { output: { total_files: rows.length, files: rows.slice(0, 400).map(r => r.path + ' (' + r.len + ')') } };
  },
};
const ANDROID_REQUIRED: [string, RegExp][] = [['settings.gradle(.kts)', /^settings\.gradle(\.kts)?$/], ['root build.gradle(.kts)', /^build\.gradle(\.kts)?$/], ['app/build.gradle(.kts)', /^app\/build\.gradle(\.kts)?$/], ['app/src/main/AndroidManifest.xml', /^app\/src\/main\/AndroidManifest\.xml$/], ['a .kt or .java source file', /\.(kt|java)$/]];
const projectZip: Tool = {
  name: 'project_zip', description: 'Package all saved project files into a downloadable .zip and verify it by re-opening it. Use kind "android" for an Android Studio project (checks the required Gradle/manifest/source files).',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'zip file name, e.g. MyApp.zip' }, kind: { type: 'string', enum: ['android', 'generic'] } }, required: ['name'] },
  async run({ name, kind }, ctx) {
    const rows = await ctx.db.all('SELECT path, content FROM project_files WHERE task_id=? ORDER BY path', ctx.taskId) as any[];
    if (!rows.length) throw new Error('no project files saved yet');
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
    const fname = String(name || 'project.zip').replace(/[^\w.\-]/g, '_').replace(/(\.zip)?$/i, '.zip').slice(0, 80);
    if (buf.length > 20 * 1024 * 1024) throw new Error('zip is larger than 20 MB');
    const id = randomUUID();
    await ctx.db.run('INSERT INTO files(id,user_id,name,mime,size,origin,text,data,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ctx.userId, fname, 'application/zip', buf.length, 'generated', null, buf.toString('base64'), ctx.taskId, Date.now());
    return { output: { file_id: id, name: fname, size: buf.length, files: rows.length }, verified: { ok: true, detail: `أعيد فتح الملف المضغوط: ${rows.length} ملف مطابقة للمحتوى` + (kind === 'android' ? ' وهيكل Android الأساسي موجود' : '') }, fileId: id };
  },
};

async function saveGenerated(ctx: ToolCtx, name: string, mime: string, buf: Buffer) {
  const id = randomUUID();
  await ctx.db.run('INSERT INTO files(id,user_id,name,mime,size,origin,text,data,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ctx.userId, name, mime, buf.length, 'generated', null, buf.toString('base64'), ctx.taskId, Date.now());
  return id;
}
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
export const TOOLS: Record<string, Tool> = Object.fromEntries([webSearch, webRead, readFile, createDoc, generateImage, editImage, projectWrite, projectStatus, projectZip, saveMemory, createReminder, listReminders, cancelReminder].map(t => [t.name, t]));

export interface AgentDef { id: string; name: string; instructions: string; tools: string[]; maxIter?: number }
export const AGENTS: Record<string, AgentDef> = {
  general: { id: 'general', name: 'المساعد الرئيسي', tools: ['web_search', 'web_read', 'read_file', 'create_document', 'generate_image', 'edit_image', 'save_memory', 'create_reminder', 'list_reminders', 'cancel_reminder'],
    instructions: 'You are Chat Luck, the lead assistant. Pick the right tool when a task needs real information, files, images or saved preferences; otherwise answer directly. Requests for a picture, design, logo, poster or illustration: call generate_image right away with an English prompt. Attached picture to enhance/resize/crop/convert: call edit_image.' },
  tasks: { id: 'tasks', name: 'وكيل المهام', tools: ['create_reminder', 'list_reminders', 'cancel_reminder', 'save_memory'],
    instructions: 'You are the Task Management Agent. Create, list and cancel reminders. Always confirm the exact local date and time you set. Reminders are best effort because the server can be asleep; say so.' },
  research: { id: 'research', name: 'وكيل البحث', tools: ['web_search', 'web_read'],
    instructions: 'You are the Research Agent. Search the web, open pages when needed, compare sources and report with source links. Label each claim as confirmed (has a source) or unconfirmed. Never state recent facts, prices or availability without a source.' },
  dev: { id: 'dev', name: 'وكيل البرمجة', maxIter: 60, tools: ['project_write', 'project_status', 'project_zip', 'web_search', 'web_read'],
    instructions: 'You are the Software Project Agent. You generate real multi-file source projects (for example a full Android Studio project in Kotlin with Gradle Kotlin DSL) as a downloadable zip. Method: 1) write a short plan with the full file tree, 2) save files with project_write in batches of at most 12 files, each file COMPLETE and consistent with the others (package names, imports, resource ids, manifest entries), no TODO placeholders, 3) call project_status to check nothing is missing, 4) call project_zip (kind android for Android). Do not include binary files (gradle-wrapper.jar, images): include gradle/wrapper/gradle-wrapper.properties and a README that says to open the project in Android Studio and let it sync. You cannot compile or run the code here, so NEVER say it builds or works; say it was generated but not compiled or tested, and may need fixes. Do not put secrets or API keys in files. In your final answer give a short summary of the structure, the file count from the tool result, and the honest limits.' },
  files: { id: 'files', name: 'وكيل الملفات', tools: ['read_file', 'create_document', 'generate_image', 'edit_image'],
    instructions: 'You are the Files Agent. Read the user\'s uploaded files, analyse and summarise them, and create real DOCX/XLSX/PPTX/PDF files when asked. Do not claim a file exists unless create_document succeeded.' },
};
export const toolSpecs = (names: string[]): ToolSpec[] => names.map(n => TOOLS[n]).filter(Boolean).map(({ name, description, parameters }) => ({ name, description, parameters }));
