import type { Logger } from 'pino';
import type { ResolvedAppDeps } from '../app.js';
import { HttpError } from '../http/errors.js';
import { providerConfig } from '../providers/config.js';
import { HttpStatusError, NetworkError } from '../providers/http.js';
import { generateChat, type ChatRequest } from '../providers/llm.js';
import { loadStoredSettings } from '../settings/stored.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { pySlice } from '../shared/pystr.js';

/** Maps to 504. Nothing throws it today: the per-request timeout grades 503 (deliberate change 2). */
export class LlmDeadlineError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'LlmDeadlineError';
  }
}

/** Port of `llm_error_to_http`: the graded HttpError for a failed `generateChat`, logged under `event`. */
export function llmErrorToHttp(e: unknown, event: string, logger: Logger): HttpError {
  const error = e instanceof Error ? e.message : String(e);
  if (e instanceof LlmDeadlineError) {
    logger.warn({ error, reason: 'timeout' }, event);
    return new HttpError(504, 'LLM request timed out. Try again.');
  }
  if (e instanceof NetworkError || (e instanceof Error && e.name === 'TimeoutError')) {
    logger.warn({ error, reason: 'llm_unreachable' }, event);
    return new HttpError(503, 'LLM provider unreachable. Try again in a moment.');
  }
  if (e instanceof HttpStatusError) {
    logger.warn({ error, reason: 'llm_http_error', upstream_status: e.status }, event);
    if (e.status >= 400 && e.status < 500) return new HttpError(502, 'LLM provider rejected our request.');
    return new HttpError(503, 'LLM provider error. Try again in a moment.');
  }
  if (e instanceof TypeError || e instanceof SyntaxError) {
    logger.warn({ error, reason: 'bad_input' }, event);
    return new HttpError(400, `Invalid input: ${pySlice(e.message, 0, 200)}`);
  }
  logger.error({ error, error_type: e instanceof Error ? e.constructor.name : typeof e }, event);
  return new HttpError(500, 'Internal error. See server logs.');
}

export type ApiLlm = {
  chat(req: Omit<ChatRequest, 'signal'>): Promise<string>;
};

/**
 * An LLM client bound to one user's resolved settings. The settings are read once, so concurrent requests
 * for different users never share a key or model. Resolves with `providerConfig` (deliberate change 1).
 */
export async function apiLlm(deps: ResolvedAppDeps, userId: string): Promise<ApiLlm> {
  const stored = await loadStoredSettings(deps.sql, userId || STUB_USER_ID);
  const p = providerConfig(stored, deps.env, deps.config);
  return { chat: (req) => generateChat(p, deps.providers, req) };
}
