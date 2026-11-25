export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
export interface ProviderModel { id: string; provider: string; label: string }
export interface Provider {
  name: string;
  configured(): boolean;
  /** Live check of which models respond. Only these are shown to users. */
  listModels(): Promise<ProviderModel[]>;
  chatStream(model: string, messages: ChatMsg[], signal: AbortSignal): AsyncGenerator<string>;
}
