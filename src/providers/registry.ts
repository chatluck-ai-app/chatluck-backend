import { config } from '../config.ts';
import { OpenAICompat } from './openaiCompat.ts';
import type { Provider, ProviderModel } from './types.ts';
export function buildProviders(): Provider[] {
  const gem = new OpenAICompat('gemini', config.gemini.base, config.gemini.key, (process.env.GEMINI_MODELS ?? 'gemini-flash-lite-latest,gemini-flash-latest').split(','), (process.env.GEMINI_API_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const fb: [string, string, string, string][] = [
    ['groq', 'https://api.groq.com/openai/v1', process.env.GROQ_API_KEY ?? '', process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'],
    ['openrouter', 'https://openrouter.ai/api/v1', process.env.OPENROUTER_API_KEY ?? '', process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free'],
    ['huggingface', 'https://router.huggingface.co/v1', process.env.HF_TOKEN ?? '', process.env.HF_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct'],
  ];
  const out: Provider[] = [
    new OpenAICompat('openai', config.openai.base, config.openai.key, (process.env.OPENAI_MODELS ?? 'gpt-4o-mini,gpt-4o').split(',')),
    gem,
  ];
  for (const [n, base, key, model] of fb) {
    const p = new OpenAICompat(n, base, key, [model]);
    gem.fallbacks.push({ p, model });
    // Also directly selectable as "<n>:<model>" when its key is set (unconfigured
    // providers list no models, so this adds no noise when the key is absent).
    out.push(p);
  }
  return out;
}
export class ModelRegistry {
  cache: ProviderModel[] = []; at = 0;
  providers: Provider[];
  constructor(providers: Provider[]) { this.providers = providers; }
  async models(force = false) {
    if (!force && Date.now() - this.at < 10 * 60_000) return this.cache;
    const lists = await Promise.all(this.providers.map(p => p.listModels()));
    this.cache = lists.flat(); this.at = Date.now(); return this.cache;
  }
  provider(name: string) { return this.providers.find(p => p.name === name); }
}
