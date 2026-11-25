export type ToolCall = { id: string; name: string; arguments: string; extra?: any };
export type ChatMsg =
  | { role: 'system' | 'user'; content: string | any[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: any }[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ProviderModel { id: string; provider: string; label: string }
export interface ToolSpec { name: string; description: string; parameters: any }
export interface Provider {
  name: string;
  configured(): boolean;
  /** Live check of which models respond. Only these are shown to users. */
  listModels(): Promise<ProviderModel[]>;
  chatStream(model: string, messages: ChatMsg[], signal: AbortSignal): AsyncGenerator<string>;
  /** Non-streaming call with optional function tools. */
  chat?(model: string, messages: ChatMsg[], tools: ToolSpec[], signal: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }>;
  /** Grounded web search (provider-specific). */
  search?(query: string, signal: AbortSignal): Promise<{ answer: string; sources: { title: string; url: string }[] }>;
}
