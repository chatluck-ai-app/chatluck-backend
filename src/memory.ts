import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
/** Rejects anything that looks like a secret. Returns a reason or null. */
export function secretReason(text: string): string | null {
  const t = text.normalize('NFKC');
  if (/(?:\d[ -]?){13,19}/.test(t.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))) return 'يبدو كرقم بطاقة أو حساب';
  if (/(password|passwd|passcode|pin code|cvv|cvc|api[ _-]?key|secret|token|private key|seed phrase|كلمة (ال)?(مرور|سر)|رمز (ال)?(سري|تحقق)|باسورد|الرقم السري)/i.test(t)) return 'يبدو كمعلومة سرية (كلمة مرور أو مفتاح)';
  if (/(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AQ\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.)/.test(t)) return 'يبدو كمفتاح API';
  return null;
}
export async function memoryEnabled(db: Db, uid: string) {
  const r: any = await db.get('SELECT memory_enabled m FROM user_settings WHERE user_id=?', uid);
  return r ? !!Number(r.m) : true;
}
export async function addMemory(db: Db, uid: string, content: string, kind = 'preference') {
  const c = content.trim().slice(0, 500);
  if (!c) throw new MemoryError('empty', 'المحتوى فارغ.');
  const why = secretReason(c); if (why) throw new MemoryError('secret', 'لم أحفظه: ' + why + '. لا أحفظ كلمات المرور أو البيانات البنكية.');
  if (!(await memoryEnabled(db, uid))) throw new MemoryError('disabled', 'الذاكرة متوقفة من الإعدادات.');
  const n: any = await db.get('SELECT count(*) c FROM memories WHERE user_id=?', uid);
  if (Number(n.c) >= 200) throw new MemoryError('full', 'الذاكرة ممتلئة (200 عنصر). احذف بعض العناصر.');
  const id = randomUUID(); await db.run('INSERT INTO memories(id,user_id,kind,content,created_at) VALUES(?,?,?,?,?)', id, uid, kind, c, Date.now());
  return { id, kind, content: c };
}
export class MemoryError extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }
/** Text block added to the system prompt (empty when memory is off or empty). */
export async function memoryPrompt(db: Db, uid: string) {
  if (!(await memoryEnabled(db, uid))) return '';
  const rows = await db.all('SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 30', uid) as any[];
  if (!rows.length) return '';
  return '\nThings the user allowed you to remember (use only when relevant; do not mention them unless useful):\n' + rows.map(r => '- ' + r.content).join('\n');
}
