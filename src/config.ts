export const config = {
  port: Number(process.env.PORT ?? 8080),
  jwtSecret: process.env.JWT_SECRET ?? '',
  dbPath: process.env.DB_PATH ?? './chatluck.db',
  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  openai: { key: process.env.OPENAI_API_KEY ?? '', base: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1' },
  gemini: { key: process.env.GEMINI_API_KEY ?? '', base: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai' },
  freeDailyMessages: Number(process.env.FREE_DAILY_MESSAGES ?? 30),
  guestDailyMessages: Number(process.env.GUEST_DAILY_MESSAGES ?? 10),
};
export function assertConfig() {
  if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
}
