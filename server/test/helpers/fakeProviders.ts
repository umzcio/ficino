import type { AnthropicLike, ProviderDeps } from '../../src/providers/deps.js';

export type FakeCall = {
  kind: 'ollama-chat' | 'ollama-embed' | 'anthropic';
  apiKey?: string;
  model?: string;
  body: unknown;
};

/** What a chat call is for, read from its system prompt. */
export type ChatPurpose = 'metadata' | 'context' | 'vision' | 'other';

export type ChatInfo = { purpose: ChatPurpose; system: string; user: string; via: 'ollama' | 'anthropic' };

export type FakeProviderOpts = {
  /** Reply text for every non-detector chat (metadata, context, vision). May return a never-settling promise. */
  chat?: (body: unknown, info: ChatInfo) => string | Promise<string>;
  /** Raw detector figures for a page (1-based), serialized as `{"figures": [...]}`. */
  detect?: (pageNumber: number) => unknown[];
  /** Vector length; defaults to the request's `dimensions`, else 1024. */
  dim?: number;
  /** Wait this long (abortably) before every reply, so concurrent jobs interleave. */
  delayMs?: number;
};

const DETECT_SYSTEM = 'You identify the scientific figures';

function purposeOf(system: string): ChatPurpose {
  if (system.startsWith('You are a precise metadata extractor')) return 'metadata';
  if (system.startsWith('You situate a short excerpt')) return 'context';
  if (system.startsWith('You are an academic paper text extractor')) return 'vision';
  return 'other';
}

/** Deterministic `dim`-length vector seeded by the text (FNV-1a seed, mulberry32 stream). */
export function fakeVector(text: string, dim: number): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  const out: number[] = [];
  for (let i = 0; i < dim; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out.push(((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5);
  }
  return out;
}

/** Settle with `p`, or reject with the signal's reason once it aborts. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const defaultChat = (_body: unknown, info: ChatInfo): string => {
  if (info.purpose === 'metadata') return '{"title": null, "authors": [], "year": null, "doi": null, "tags": []}';
  if (info.purpose === 'context') return 'A situating sentence.';
  return 'Page text.';
};

/** Provider deps backed by a fake Ollama (`/api/chat`, `/api/embed`) and a fake Anthropic factory; every call is recorded. */
export function fakeProviders(opts: FakeProviderOpts = {}): { deps: ProviderDeps; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const chat = opts.chat ?? defaultChat;
  const detect = opts.detect ?? (() => []);
  const delay = async (signal?: AbortSignal | null) => {
    if (opts.delayMs) await abortable(new Promise((r) => setTimeout(r, opts.delayMs)), signal);
  };
  const detectReply = (user: string): string => {
    const page = Number(/This is page (\d+) of/.exec(user)?.[1]);
    return JSON.stringify({ figures: detect(page) });
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
    const signal = init?.signal;
    if (url.endsWith('/api/embed')) {
      calls.push({ kind: 'ollama-embed', model: String(body.model), body });
      await delay(signal);
      const dim = opts.dim ?? Number(body.dimensions ?? 1024);
      const input = body.input as string[];
      return Response.json({ embeddings: input.map((t) => fakeVector(t, dim)) });
    }
    if (url.endsWith('/api/chat')) {
      calls.push({ kind: 'ollama-chat', model: String(body.model), body });
      await delay(signal);
      const messages = body.messages as Array<{ role: string; content: string }>;
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const content = system.startsWith(DETECT_SYSTEM)
        ? detectReply(user)
        : await abortable(Promise.resolve(chat(body, { purpose: purposeOf(system), system, user, via: 'ollama' })), signal);
      return Response.json({ message: { role: 'assistant', content } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const anthropic = (apiKey: string): AnthropicLike => ({
    messages: {
      async create(params, o) {
        calls.push({ kind: 'anthropic', apiKey, model: String(params.model), body: params });
        await delay(o?.signal);
        const sys = params.system;
        const system = typeof sys === 'string' ? sys : Array.isArray(sys) ? String(sys[0]?.text ?? '') : '';
        const msg = (params.messages as Array<{ content: unknown }>)[0]?.content;
        const user =
          typeof msg === 'string'
            ? msg
            : (msg as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('');
        const text = system.startsWith(DETECT_SYSTEM)
          ? detectReply(user)
          : await abortable(
              Promise.resolve(chat(params, { purpose: purposeOf(system), system, user, via: 'anthropic' })),
              o?.signal,
            );
        return { content: [{ type: 'text', text }] };
      },
    },
  });

  const sleep = (ms: number, signal?: AbortSignal) => abortable(new Promise<void>((r) => setTimeout(r, ms)), signal);
  return { deps: { fetch: fetchFn, anthropic, sleep }, calls };
}
