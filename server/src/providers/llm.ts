import type { ProviderConfig } from './config.js';
import type { ProviderDeps } from './deps.js';
import { fetchJson, isTransient, withRetry } from './http.js';

export type GenerateRequest = {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
};

async function generateOllama(p: ProviderConfig, deps: ProviderDeps, req: GenerateRequest): Promise<string> {
  const payload = {
    model: p.llm.ollamaModel,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    stream: false,
    think: false, // disable thinking mode (qwen3 etc.)
    options: { temperature: req.temperature, num_predict: req.maxTokens },
  };
  return withRetry(
    async () => {
      const data = (await fetchJson(deps, `${p.ollamaBaseUrl}/api/chat`, {
        body: payload,
        timeoutMs: 300_000,
        signal: req.signal,
      })) as { message: { content?: string; thinking?: string } };
      const msg = data.message;
      let content = msg.content ?? '';
      if (!content && msg.thinking) content = msg.thinking;
      if (!content || !content.trim()) throw new Error('LLM returned empty response');
      return content;
    },
    {
      attempts: 3,
      delaysMs: [2000, 6000],
      retryable: (e) => isTransient(e, req.signal),
      sleep: deps.sleep,
      signal: req.signal,
    },
  );
}

async function generateClaude(p: ProviderConfig, deps: ProviderDeps, req: GenerateRequest): Promise<string> {
  const client = deps.anthropic(p.llm.anthropicKey, {});
  const response = await client.messages.create(
    {
      model: p.llm.claudeModel,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    },
    { signal: req.signal },
  );
  const text = response.content[0]?.text;
  if (text === undefined) throw new Error('Anthropic response has no text content');
  return text;
}

/** Route to the job's configured LLM provider. */
export async function generateText(p: ProviderConfig, deps: ProviderDeps, req: GenerateRequest): Promise<string> {
  if (p.llm.provider === 'ollama') return generateOllama(p, deps, req);
  if (p.llm.provider === 'api' && p.llm.anthropicKey) return generateClaude(p, deps, req);
  throw new Error(`No LLM provider available (LLM_PROVIDER=${p.llm.provider})`);
}
