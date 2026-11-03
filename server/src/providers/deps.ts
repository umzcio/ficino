import Anthropic from '@anthropic-ai/sdk';

export type AnthropicLike = {
  messages: {
    create(
      params: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

/** Everything a provider client touches outside the process; tests substitute these. */
export type ProviderDeps = {
  fetch: typeof fetch;
  anthropic(apiKey: string, opts: { maxRetries?: number; timeoutMs?: number }): AnthropicLike;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function defaultProviderDeps(): ProviderDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    anthropic: (apiKey, opts) =>
      new Anthropic({ apiKey, maxRetries: opts.maxRetries, timeout: opts.timeoutMs }) as unknown as AnthropicLike,
    sleep: abortableSleep,
  };
}
