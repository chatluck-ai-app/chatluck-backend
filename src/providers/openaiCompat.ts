import type { Provider, ProviderModel, ChatMsg, ToolSpec, ToolCall } from './types.ts';
/** One adapter for any OpenAI-compatible endpoint (OpenAI itself, and Gemini's compat endpoint). */
export class OpenAICompat implements Provider {
  name: string; private base: string; private key: string; private candidates: string[];
  /** extra API keys (same provider, separate free quota) rotated on 429/503 */
  private keys: string[]; private ki = 0; private coolUntil: number[] = [];
  /** other OpenAI-compatible providers tried when every key here is busy */
  fallbacks: { p: OpenAICompat; model: string }[] = [];
  constructor(name: string, base: string, key: string, candidates: string[], extraKeys: string[] = []) { this.name = name; this.base = base; this.key = key; this.candidates = candidates; this.keys = [key, ...extraKeys].filter((k, i, a) => k && a.indexOf(k) === i); }
  configured() { return !!this.key || this.keys.length > 0; }
  private headers() { return { 'content-type': 'application/json', authorization: 'Bearer ' + (this.keys[this.ki] ?? this.key) }; }
  async listModels(): Promise<ProviderModel[]> {
    if (!this.configured()) return [];
    const out: ProviderModel[] = [];
    for (const id of this.candidates) {
      // Try every key: model availability can differ per API project, so a 404
      // on the primary key does not mean another key cannot serve the model.
      for (let k = 0; k < Math.max(1, this.keys.length); k++) {
        try {
          const r = await fetch(this.base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (this.keys[k] ?? this.key) },
            body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }), signal: AbortSignal.timeout(20000) });
          if (r.ok) { out.push({ id, provider: this.name, label: id }); break; }
          console.warn('[models] ' + this.name + '/' + id + ' key' + k + ' -> ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
        } catch (e) { console.warn('[models] ' + this.name + '/' + id + ' key' + k + ' -> ' + String(e)); }
      }
    }
    return out;
  }
  async chat(model: string, messages: ChatMsg[], tools: ToolSpec[], signal: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const body: any = { model, messages };
    if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    let r!: Response; let lastErr: ProviderError | undefined;
    const n = Math.max(1, this.keys.length);
    for (let t = 0; t < n; t++) {
      const idx = (this.ki + t) % n;
      if (this.coolUntil[idx] && this.coolUntil[idx] > Date.now() && t < n - 1) continue;
      this.ki = idx;
      r = await fetch(this.base + '/chat/completions', { method: 'POST', headers: this.headers(), signal, body: JSON.stringify(body) });
      if (r.ok) { lastErr = undefined; break; }
      lastErr = new ProviderError(r.status, (await r.text().catch(() => '')).slice(0, 300));
      if (r.status === 429 || r.status === 503) { this.coolUntil[idx] = Date.now() + (r.status === 429 ? 60_000 : 15_000); continue; }
      break;
    }
    if (lastErr) {
      if ((lastErr.status === 429 || lastErr.status === 503) && this.fallbacks.length) {
        for (const f of this.fallbacks) {
          if (!f.p.configured()) continue;
          try { return await f.p.chat(f.model, messages, tools, signal); } catch { /* try next */ }
        }
      }
      throw lastErr;
    }
    const m = (await r.json() as any).choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (m.tool_calls ?? []).map((c: any, i: number) => ({ id: c.id || 'call_' + i + '_' + Date.now(), name: c.function?.name, arguments: c.function?.arguments ?? '{}', extra: c.extra_content }));
    return { content: typeof m.content === 'string' ? m.content : '', toolCalls };
  }
  /** Gemini only: Google Search grounding through the native API. */
  async search(query: string, signal: AbortSignal) {
    const native = this.base.replace(/\/openai\/?$/, '');
    if (!this.key || native === this.base) throw new ProviderError(501, 'search not supported by this provider');
    const model = process.env.GEMINI_SEARCH_MODEL ?? this.candidates[0];
    const r = await fetch(`${native}/models/${model}:generateContent`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: query }] }], tools: [{ google_search: {} }] }) });
    if (!r.ok) throw new ProviderError(r.status, (await r.text().catch(() => '')).slice(0, 300));
    const j: any = await r.json(); const cand = j.candidates?.[0];
    const answer = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    const seen = new Set<string>(); const sources: { title: string; url: string }[] = [];
    for (const ch of cand?.groundingMetadata?.groundingChunks ?? []) {
      let url: string = ch.web?.uri; if (!url || seen.has(url)) continue; seen.add(url);
      try { const h = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) }); if (h.url) url = h.url; } catch { /* keep redirect url */ }
      sources.push({ title: ch.web?.title ?? url, url });
    }
    return { answer, sources };
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
