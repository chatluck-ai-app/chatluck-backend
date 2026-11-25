// Usage: GEMINI_API_KEY=... [OPENAI_API_KEY=...] npm run live-check
import { ModelRegistry, buildProviders } from '../src/providers/registry.ts';
const reg = new ModelRegistry(buildProviders());
for (const p of reg.providers) console.log(p.name, p.configured() ? 'key set' : 'NO KEY');
const models = await reg.models(true);
console.log('live models:', models.map(m => `${m.provider}:${m.id}`).join(', ') || 'none');
for (const m of models.slice(0, 1)) {
  let out = ''; for await (const t of reg.provider(m.provider)!.chatStream(m.id, [{ role: 'user', content: 'قل مرحبا بكلمة واحدة' }], AbortSignal.timeout(30000))) out += t;
  console.log('stream test', m.provider + ':' + m.id, '->', JSON.stringify(out));
}
