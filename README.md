# Chat Luck AI backend
Node 22 + TypeScript (type-stripping, no build step), Fastify, Postgres (or SQLite for local dev).

Run locally: `npm install && JWT_SECRET=<32+ chars> GEMINI_API_KEY=... npm start`
Test: `npm test`. Live provider check: `GEMINI_API_KEY=... npm run live-check`.

## Free deploy (Render free web service + Neon free Postgres)
1. Neon: create project, copy the connection string (postgres://...sslmode=require).
2. Render: New > Web Service > this repo. Runtime Node, build `npm install`, start `npm start`, plan Free, health check `/health`.
3. Env vars on Render: NODE_VERSION=22, JWT_SECRET (random 32+), DATABASE_URL (Neon string), GEMINI_API_KEY, optional OPENAI_API_KEY, ADMIN_EMAILS.
4. Check `https://<service>.onrender.com/health`, then `/v1/models` after registering a user.
Free limits: web service sleeps after 15 idle minutes (about 1 min to wake); Neon scales to zero after 5 idle minutes.
No secrets are stored in this repo; all keys are env vars.
