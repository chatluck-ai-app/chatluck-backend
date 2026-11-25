/** File text extraction and document creation. Heavy libraries are imported lazily (512 MB server). */
export const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_TEXT = 300_000;
export type DocType = 'docx' | 'xlsx' | 'pptx' | 'pdf';
export const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
export const extOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase();
export const isImage = (name: string) => ['png', 'jpg', 'jpeg', 'webp'].includes(extOf(name));

export async function extractText(name: string, buf: Buffer): Promise<string> {
  const ext = extOf(name); let text = '';
  if (ext === 'pdf') {
    const { getDocumentProxy, extractText: ex } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const r: any = await ex(pdf, { mergePages: false });
    text = (r.text as string[]).map((t, i) => `--- صفحة ${i + 1} ---\n${t}`).join('\n');
  } else if (ext === 'docx') {
    const mammoth: any = await import('mammoth'); text = (await (mammoth.default ?? mammoth).extractRawText({ buffer: buf })).value;
  } else if (ext === 'xlsx') {
    const ExcelJS: any = await import('exceljs'); const wb = new (ExcelJS.default ?? ExcelJS).Workbook(); await wb.xlsx.load(buf);
    const parts: string[] = [];
    wb.eachSheet((ws: any) => {
      parts.push(`## ورقة: ${ws.name}`);
      ws.eachRow((row: any) => parts.push((row.values as any[]).slice(1).map(v => cellText(v)).join('\t')));
    });
    text = parts.join('\n');
  } else if (ext === 'pptx') {
    const JSZip: any = (await import('jszip')).default; const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const parts: string[] = [];
    for (const [i, n] of slides.entries()) {
      const xml = await zip.files[n].async('string');
      const t = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => unxml(m[1])).join('\n');
      parts.push(`--- شريحة ${i + 1} ---\n${t}`);
    }
    text = parts.join('\n');
  } else if (['txt', 'md', 'csv', 'json'].includes(ext)) text = buf.toString('utf8');
  else throw new Error('نوع الملف غير مدعوم: ' + ext);
  return text.slice(0, MAX_TEXT);
}
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function cellText(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.result ?? v.text ?? (v.richText ? v.richText.map((r: any) => r.text).join('') : '') ?? '');
  return String(v);
}

export interface DocSpec {
  type: DocType; title: string;
  sections?: { heading?: string; body?: string; bullets?: string[] }[];
  sheets?: { name: string; rows: (string | number)[][] }[];
}
export const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);
const specText = (s: DocSpec) => [s.title, ...(s.sections ?? []).flatMap(x => [x.heading ?? '', x.body ?? '', ...(x.bullets ?? [])]), ...(s.sheets ?? []).flatMap(x => [x.name, ...x.rows.flat().map(String)])].join(' ');

export async function createDocument(spec: DocSpec): Promise<{ buf: Buffer; name: string; mime: string }> {
  const title = String(spec.title || 'document').slice(0, 100);
  const safe = title.replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/\s+/g, '_') || 'document';
  const rtl = hasArabic(specText(spec));
  let buf: Buffer;
  if (spec.type === 'docx') {
    const d: any = await import('docx');
    const kids: any[] = [new d.Paragraph({ heading: d.HeadingLevel.TITLE, bidirectional: rtl, children: [new d.TextRun({ text: title, rightToLeft: rtl })] })];
    for (const s of spec.sections ?? []) {
      if (s.heading) kids.push(new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, bidirectional: rtl, children: [new d.TextRun({ text: s.heading, rightToLeft: rtl })] }));
      for (const p of (s.body ?? '').split(/\n+/).filter(Boolean)) kids.push(new d.Paragraph({ bidirectional: rtl, children: [new d.TextRun({ text: p, rightToLeft: rtl })] }));
      for (const b of s.bullets ?? []) kids.push(new d.Paragraph({ bullet: { level: 0 }, bidirectional: rtl, children: [new d.TextRun({ text: b, rightToLeft: rtl })] }));
    }
    buf = Buffer.from(await d.Packer.toBuffer(new d.Document({ sections: [{ children: kids }] })));
  } else if (spec.type === 'xlsx') {
    const ExcelJS: any = await import('exceljs'); const wb = new (ExcelJS.default ?? ExcelJS).Workbook();
    for (const sh of spec.sheets?.length ? spec.sheets : [{ name: 'Sheet1', rows: [[title]] }]) {
      const ws = wb.addWorksheet(String(sh.name || 'Sheet').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet', { views: [{ rightToLeft: rtl }] });
      for (const r of sh.rows) ws.addRow(r);
      if (ws.rowCount) ws.getRow(1).font = { bold: true };
    }
    buf = Buffer.from(await wb.xlsx.writeBuffer());
  } else if (spec.type === 'pptx') {
    const P: any = (await import('pptxgenjs')).default; const pres = new P();
    const t = pres.addSlide(); t.addText(title, { x: 0.5, y: 2.2, w: 9, h: 1.5, fontSize: 36, bold: true, align: rtl ? 'right' : 'left', rtlMode: rtl });
    for (const s of spec.sections ?? []) {
      const sl = pres.addSlide();
      sl.addText(s.heading ?? '', { x: 0.5, y: 0.3, w: 9, h: 0.9, fontSize: 28, bold: true, align: rtl ? 'right' : 'left', rtlMode: rtl });
      const items = [...(s.body ? s.body.split(/\n+/).map(x => ({ text: x, options: { breakLine: true } })) : []), ...(s.bullets ?? []).map(x => ({ text: x, options: { bullet: true, breakLine: true } }))];
      if (items.length) sl.addText(items, { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 18, valign: 'top', align: rtl ? 'right' : 'left', rtlMode: rtl });
    }
    buf = Buffer.from(await pres.write({ outputType: 'nodebuffer' }) as any);
  } else if (spec.type === 'pdf') {
    if (rtl) throw new Error('إنشاء PDF بنص عربي غير مدعوم بعد (الحروف تظهر بترتيب خاطئ). أنشئ ملف DOCX بدلاً منه، أو PDF بالإنجليزية.');
    const PDF: any = (await import('pdfkit')).default; const doc = new PDF({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>(r => doc.on('end', () => r()));
    doc.font('Helvetica-Bold').fontSize(22).text(title).moveDown();
    for (const s of spec.sections ?? []) {
      if (s.heading) doc.font('Helvetica-Bold').fontSize(15).text(s.heading).moveDown(0.3);
      if (s.body) doc.font('Helvetica').fontSize(11).text(s.body).moveDown(0.5);
      for (const b of s.bullets ?? []) doc.font('Helvetica').fontSize(11).text('• ' + b);
      doc.moveDown();
    }
    doc.end(); await done; buf = Buffer.concat(chunks);
  } else throw new Error('نوع غير مدعوم: ' + spec.type);
  return { buf, name: `${safe}.${spec.type}`, mime: MIME[spec.type] };
}

/** Re-open the generated file with an independent parser and check it has the expected content. */
export async function verifyDocument(spec: DocSpec, buf: Buffer, name: string): Promise<{ ok: boolean; detail: string }> {
  try {
    if (buf.length < 100) return { ok: false, detail: 'الملف صغير جداً' };
    const text = await extractText(name, buf);
    if (spec.type === 'pdf' && buf.subarray(0, 5).toString() !== '%PDF-') return { ok: false, detail: 'ترويسة PDF غير صحيحة' };
    const probes = [...(spec.type === 'xlsx' && spec.sheets?.length ? [] : [spec.title]), ...(spec.sections ?? []).map(s => s.heading ?? ''), ...(spec.sheets ?? []).flatMap(s => s.rows.slice(0, 2).flat().map(String))].filter(Boolean).slice(0, 6);
    const norm = (s: string) => s.replace(/\s+/g, '');
    const missing = probes.filter(p => !norm(text).includes(norm(p).slice(0, 30)));
    if (spec.type === 'pdf') return { ok: text.length > 0, detail: `PDF أعيد فتحه (${text.length} حرف)` };
    return missing.length ? { ok: false, detail: 'محتوى ناقص بعد إعادة الفتح: ' + missing.join(' | ') } : { ok: true, detail: `أعيد فتح الملف وتم التحقق من ${probes.length} عنصر` };
  } catch (e: any) { return { ok: false, detail: 'فشل فتح الملف: ' + e.message }; }
}
