import type { Provider, ProviderModel, ChatMsg } from './types.ts';
/** One adapter for any OpenAI-compatible endpoint (OpenAI itself, and Gemini's compat endpoint). */
export class OpenAICompat implements Provider {
  name: string; private base: string; private key: string; private candidates: string[];
  constructor(name: string, base: string, key: string, candidates: string[]) { this.name = name; this.base = base; this.key = key; this.candidates = candidates; }
  configured() { return !!this.key; }
  private headers() { return { 'content-type': 'application/json', authorization: 'Bearer ' + this.key }; }
  async listModels(): Promise<ProviderModel[]> {
    if (!this.configured()) return [];
    const out: ProviderModel[] = [];
    for (const id of this.candidates) {
      try {
        const r = await fetch(this.base + '/chat/completions', { method: 'POST', headers: this.headers(),
          body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }), signal: AbortSignal.timeout(20000) });
        if (r.ok) out.push({ id, provider: this.name, label: id });
      } catch { /* unavailable */ }
    }
    return out;
  }
  async *chatStream(model: string, messages: ChatMsg[], signal: AbortSignal) {
    const r = await fetch(this.base + '/chat/completions', { method: 'POST', headers: this.headers(), signal,
      body: JSON.stringify({ model, messages, stream: true }) });
    if (!r.ok || !r.body) throw new ProviderError(r.status, (await r.text().catch(() => '')).slice(0, 300));
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (d === '[DONE]') return;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) yield t as string; } catch { /* partial */ }
      }
    }
  }
}
export class ProviderError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
