import type { ProviderConfig } from './config.js';
import type { ProviderDeps } from './deps.js';
import { pyStrip } from '../shared/pystr.js';
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
      if (!content || !pyStrip(content)) throw new Error('LLM returned empty response');
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

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type ChatRequest = {
  system: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
};

const CHAT_TIMEOUT_MS = 120_000;

/** Port of api/services/llm.py `_post_ollama_chat_with_retry` + the Ollama branch of `generate_response`. */
async function chatOllama(p: ProviderConfig, deps: ProviderDeps, req: ChatRequest): Promise<string> {
  const payload = {
    model: p.llm.ollamaModel,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    stream: false,
    think: false,
    options: { temperature: req.temperature, num_predict: req.maxTokens },
  };
  return withRetry(
    async () => {
      const data = (await fetchJson(deps, `${p.ollamaBaseUrl}/api/chat`, {
        body: payload,
        timeoutMs: CHAT_TIMEOUT_MS,
        signal: req.signal,
      })) as { message: { content?: string; thinking?: string } };
      const msg = data.message;
      let content = msg.content ?? '';
      if (!content && msg.thinking) content = msg.thinking;
      if (!content || !pyStrip(content)) throw new Error('LLM returned empty response');
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

async function chatAnthropic(p: ProviderConfig, deps: ProviderDeps, req: ChatRequest): Promise<string> {
  const client = deps.anthropic(p.llm.anthropicKey, {
    maxRetries: 0,
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  const response = await client.messages.create(
    {
      model: p.llm.claudeModel,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      temperature: req.temperature,
    },
    { signal: req.signal },
  );
  const text = response.content[0]?.text;
  if (text === undefined) throw new Error('Anthropic response has no text content');
  return text;
}

/** Port of `generate_response`: multi-turn chat. Ollama when configured; anything else is Anthropic, as in Python. */
export async function generateChat(p: ProviderConfig, deps: ProviderDeps, req: ChatRequest): Promise<string> {
  return p.llm.provider === 'ollama' ? chatOllama(p, deps, req) : chatAnthropic(p, deps, req);
}
