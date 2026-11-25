import { config } from './config.ts';
export interface Db {
  get(sql: string, ...p: unknown[]): Promise<any>;
  all(sql: string, ...p: unknown[]): Promise<any[]>;
  run(sql: string, ...p: unknown[]): Promise<void>;
  kind: 'sqlite' | 'pg';
}
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE, pass_hash TEXT, is_guest INTEGER DEFAULT 0, plan TEXT DEFAULT 'free', is_admin INTEGER DEFAULT 0, created_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT, model TEXT, assistant_id TEXT, archived INTEGER DEFAULT 0, created_at BIGINT, updated_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS ix_conv_user ON conversations(user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS ix_msg_conv ON messages(conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS usage_records(user_id TEXT NOT NULL, day TEXT, kind TEXT, model TEXT, chars_in INTEGER, chars_out INTEGER)`,
  `CREATE INDEX IF NOT EXISTS ix_usage ON usage_records(user_id, day, kind)`,
  `CREATE TABLE IF NOT EXISTS assistants(id TEXT PRIMARY KEY, user_id TEXT, name TEXT, instructions TEXT, builtin INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS plan_limits(plan TEXT PRIMARY KEY, daily_messages INTEGER)`,
];
async function init(db: Db) {
  for (const s of SCHEMA) await db.run(s);
  await db.run('INSERT INTO plan_limits(plan,daily_messages) VALUES(?,?) ON CONFLICT(plan) DO NOTHING', 'free', config.freeDailyMessages);
  await db.run('INSERT INTO plan_limits(plan,daily_messages) VALUES(?,?) ON CONFLICT(plan) DO NOTHING', 'guest', config.guestDailyMessages);
  return db;
}
const num = (r: any) => { if (r) for (const k of Object.keys(r)) if (typeof r[k] === 'bigint') r[k] = Number(r[k]); return r; };
export async function openSqlite(path = config.dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const s = new Database(path); s.pragma('journal_mode = WAL'); s.pragma('foreign_keys = ON');
  const db: Db = { kind: 'sqlite',
    get: async (q, ...p) => num(s.prepare(q).get(...p as any[])),
    all: async (q, ...p) => s.prepare(q).all(...p as any[]).map(num),
    run: async (q, ...p) => { s.prepare(q).run(...p as any[]); } };
  return init(db);
}
export function pgFromPool(pool: any): Promise<Db> {
  const conv = (q: string) => { let i = 0; return q.replace(/\?/g, () => '$' + (++i)); };
  const db: Db = { kind: 'pg',
    get: async (q, ...p) => (await pool.query(conv(q), p)).rows[0],
    all: async (q, ...p) => (await pool.query(conv(q), p)).rows,
    run: async (q, ...p) => { await pool.query(conv(q), p); } };
  return init(db);
}
export async function openPg(url: string) {
  const pg = await import('pg');
  pg.default.types.setTypeParser(20, (v: string) => Number(v)); // BIGINT -> number
  const pool = new pg.default.Pool({ connectionString: url, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  return pgFromPool(pool);
}
/** DATABASE_URL set -> Postgres (production). Otherwise SQLite (local/dev only). */
export async function openDb() {
  return process.env.DATABASE_URL ? openPg(process.env.DATABASE_URL) : openSqlite();
}
