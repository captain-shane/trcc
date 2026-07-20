import { config } from '../config.js';

// Local model client. The ONLY external endpoint this app ever talks to is
// the configured local model server — Ollama, LM Studio, llama.cpp, vLLM,
// or anything else speaking either:
//   - the Ollama native API   (/api/generate, /api/embed, /api/tags)
//   - the OpenAI-compatible API (/v1/chat/completions, /v1/embeddings, /v1/models)
// The protocol is auto-detected and cached; override with AI_API_STYLE=ollama|openai.

export class AiUnavailableError extends Error {
  constructor(msg: string) { super(msg); this.name = 'AiUnavailableError'; }
}

type ApiStyle = 'ollama' | 'openai';

let styleCache: { style: ApiStyle; at: number } | null = null;
const STYLE_TTL = 5 * 60_000;

async function probe(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.aiUrl}${path}`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function detectStyle(): Promise<ApiStyle> {
  const forced = process.env.AI_API_STYLE;
  if (forced === 'ollama' || forced === 'openai') return forced;
  if (styleCache && Date.now() - styleCache.at < STYLE_TTL) return styleCache.style;
  if (await probe('/api/tags')) {
    styleCache = { style: 'ollama', at: Date.now() };
    return 'ollama';
  }
  if (await probe('/v1/models')) {
    styleCache = { style: 'openai', at: Date.now() };
    return 'openai';
  }
  styleCache = null;
  throw new AiUnavailableError(
    `No local model server responding at ${config.aiUrl} (tried Ollama and OpenAI-compatible APIs)`);
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.aiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiUnavailableError(`Local model server unreachable at ${config.aiUrl} (${(e as Error).message})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiUnavailableError(`Local model server ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Run a prompt on the local model. Long timeout: big models are slow. */
export async function generate(prompt: string, model: string, timeoutMs = 180_000): Promise<string> {
  const style = await detectStyle();
  if (style === 'ollama') {
    const data = await post<{ response?: string }>('/api/generate', { model, prompt, stream: false }, timeoutMs);
    return (data.response ?? '').trim();
  }
  const data = await post<{ choices?: { message?: { content?: string } }[] }>(
    '/v1/chat/completions',
    { model, messages: [{ role: 'user', content: prompt }], stream: false },
    timeoutMs);
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

/** Embed a batch of texts. */
export async function embed(texts: string[], model: string): Promise<number[][]> {
  const style = await detectStyle();
  if (style === 'ollama') {
    const data = await post<{ embeddings?: number[][] }>('/api/embed', { model, input: texts }, 60_000);
    if (!data.embeddings) throw new AiUnavailableError('Local model server returned no embeddings');
    return data.embeddings;
  }
  const data = await post<{ data?: { index: number; embedding: number[] }[] }>(
    '/v1/embeddings', { model, input: texts }, 60_000);
  if (!data.data) throw new AiUnavailableError('Local model server returned no embeddings');
  return [...data.data].sort((a, b) => a.index - b.index).map(d => d.embedding);
}

/** List models available on the local server. */
export async function listModels(): Promise<string[]> {
  const style = await detectStyle();
  try {
    if (style === 'ollama') {
      const res = await fetch(`${config.aiUrl}/api/tags`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new AiUnavailableError(`Local model server ${res.status}`);
      const data = await res.json() as { models?: { name: string }[] };
      return (data.models ?? []).map(m => m.name);
    }
    const res = await fetch(`${config.aiUrl}/v1/models`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new AiUnavailableError(`Local model server ${res.status}`);
    const data = await res.json() as { data?: { id: string }[] };
    return (data.data ?? []).map(m => m.id);
  } catch (e) {
    if (e instanceof AiUnavailableError) throw e;
    throw new AiUnavailableError(`Local model server unreachable at ${config.aiUrl} (${(e as Error).message})`);
  }
}

/** Quick reachability probe for UI status badges. Returns the detected style. */
export async function serverInfo(): Promise<{ style: ApiStyle; models: string[] } | null> {
  try {
    const style = await detectStyle();
    return { style, models: await listModels() };
  } catch {
    return null;
  }
}

function isOom(e: unknown): boolean {
  return /out of memory|OOM|CUDA error/i.test((e as Error).message ?? '');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface GenResult {
  text: string;
  model: string;      // model that actually produced the text
  fellBack: boolean;  // true when the quality model OOM'd and the fast model stepped in
}

/**
 * Generate on the preferred (quality) model, but survive GPU memory pressure:
 * on an out-of-memory error, wait for the server to free what it can and
 * retry once, then fall back to the smaller model rather than failing.
 */
export async function generateWithFallback(prompt: string, preferred: string, fallback: string, timeoutMs = 180_000): Promise<GenResult> {
  try {
    return { text: await generate(prompt, preferred, timeoutMs), model: preferred, fellBack: false };
  } catch (e1) {
    if (!isOom(e1)) throw e1;
    await sleep(4_000); // give the server a moment to evict idle models
    try {
      return { text: await generate(prompt, preferred, timeoutMs), model: preferred, fellBack: false };
    } catch (e2) {
      if (!isOom(e2) || !fallback || fallback === preferred) throw e2;
      console.warn(`GPU OOM on ${preferred}; falling back to ${fallback}`);
      return { text: await generate(prompt, fallback, timeoutMs), model: fallback, fellBack: true };
    }
  }
}

export function fillTemplate(tmpl: string, vars: Record<string, string | number>): string {
  return String(tmpl).replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    vars[k] != null ? String(vars[k]) : '');
}
