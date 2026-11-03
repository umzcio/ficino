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

/**
 * An Anthropic client that uses only the user's key. Left to itself the SDK (0.135.0) reads process.env on every
 * construction: ANTHROPIC_AUTH_TOKEN (sent as a Bearer header next to the key), ANTHROPIC_BASE_URL,
 * ANTHROPIC_WEBHOOK_SIGNING_KEY, ANTHROPIC_LOG, ANTHROPIC_OPEN_TELEMETRY*, and ANTHROPIC_CUSTOM_HEADERS (merged into
 * every request). Each is pinned by an explicit option; the custom headers are read unconditionally into
 * `_options.defaultHeaders`, and since we pass none, clearing it drops exactly the env ones.
 */
function anthropicClient(apiKey: string, opts: { maxRetries?: number; timeoutMs?: number }): AnthropicLike {
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    webhookKey: null,
    logLevel: 'warn', // the SDK default
    openTelemetry: false,
    maxRetries: opts.maxRetries,
    timeout: opts.timeoutMs,
  });
  (client as unknown as { _options: { defaultHeaders?: unknown } })._options.defaultHeaders = undefined;
  return client as unknown as AnthropicLike;
}

export function defaultProviderDeps(): ProviderDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    anthropic: anthropicClient,
    sleep: abortableSleep,
  };
}
