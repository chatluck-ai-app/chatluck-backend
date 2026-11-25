import { config } from '../config.ts';
import { OpenAICompat } from './openaiCompat.ts';
import type { Provider, ProviderModel } from './types.ts';
export function buildProviders(): Provider[] {
  return [
    new OpenAICompat('openai', config.openai.base, config.openai.key, (process.env.OPENAI_MODELS ?? 'gpt-4o-mini,gpt-4o').split(',')),
    new OpenAICompat('gemini', config.gemini.base, config.gemini.key, (process.env.GEMINI_MODELS ?? 'gemini-flash-lite-latest,gemini-flash-latest').split(',')),
  ];
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
