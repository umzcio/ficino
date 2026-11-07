import type { ProviderDeps } from './deps.js';

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'HttpStatusError';
  }
}

/** `deps.fetch` itself rejected (connection refused, DNS, reset): the only retryable non-HTTP failure. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(`network error: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'NetworkError';
  }
}

/**
 * True for a NetworkError (fetch itself rejected), a per-request timeout or a 5xx.
 * False for a 4xx and for the caller's own abort: pass the job `signal` so a cancellation is never retried.
 */
export function isTransient(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (e instanceof HttpStatusError) return e.status >= 500;
  if (e instanceof NetworkError) return true;
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TimeoutError') return true;
  return false;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    attempts: number;
    delaysMs: number[];
    retryable(e: unknown): boolean;
    sleep: ProviderDeps['sleep'];
    signal?: AbortSignal;
  },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (e) {
      if (opts.signal?.aborted || attempt >= opts.attempts - 1 || !opts.retryable(e)) throw e;
      await opts.sleep(opts.delaysMs[Math.min(attempt, opts.delaysMs.length - 1)] ?? 0, opts.signal);
    }
  }
}

type HttpInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
};

/**
 * One request with a per-request timeout (a total deadline) combined with the caller's signal. A JSON `body` is
 * serialized and sent as `application/json`. Rejects with `HttpStatusError` on a non-2xx, `NetworkError` when fetch
 * itself fails, and the timeout's or the caller's own reason otherwise. The body is read under the same signal.
 */
async function request<T>(
  deps: Pick<ProviderDeps, 'fetch'>,
  url: string,
  init: HttpInit,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal,
    });
  } catch (e) {
    // Timeouts and the caller's abort keep their own identity; anything else is a network failure.
    if (init.signal?.aborted || timeout.aborted || signal.aborted) throw e;
    throw new NetworkError(e);
  }
  if (!res.ok) throw new HttpStatusError(res.status, await res.text().catch(() => ''));
  return read(res);
}

/** One JSON request and JSON response. */
export function fetchJson(deps: Pick<ProviderDeps, 'fetch'>, url: string, init: HttpInit): Promise<unknown> {
  return request(deps, url, init, (res) => res.json());
}

/** One JSON request whose response body is returned as raw bytes (audio). */
export function fetchBytes(deps: Pick<ProviderDeps, 'fetch'>, url: string, init: HttpInit): Promise<Uint8Array> {
  return request(deps, url, init, async (res) => new Uint8Array(await res.arrayBuffer()));
}
