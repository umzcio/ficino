// Port of worker/lib/claude_client.py (post parsing, classifier) and worker/lib/post_validation.py.
import type { Logger } from 'pino';
import { generateText } from '../providers/llm.js';
import type { ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { mapLimit } from '../shared/mapLimit.js';
import { PY_WS, pyLen, pySlice, pyStrip } from '../shared/pystr.js';
import { fenceUntrusted, stripRoleMarkers } from '../shared/sanitize.js';
import type { Post } from './types.js';

export const VALID_POST_TYPES: ReadonlySet<string> = new Set(['post', 'thread', 'quote', 'reply', 'figure']);
export const MAX_CONTENT_CHARS = 2000;
const REQUIRED_FIELDS = ['persona', 'post_type', 'content'] as const;

/** The first top-level `{...}` with balanced braces, skipping string literals; null if none completes. */
export function findBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const THINK_RE = /<think>.*?<\/think>/gsu;
const FENCE_RE = new RegExp(`\`\`\`(?:json)?[${PY_WS}]*\\n?(.*?)\`\`\``, 'su');
const ANY_FENCE_RE = /```.*?```/gsu;

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Extract the first JSON value the model produced (any JSON type, as Python's json.loads), else wrap
 * substantive plain text as a post. Throws persona_post_empty_content / persona_post_content_too_long.
 * Python's json.loads also accepts NaN/Infinity; JSON.parse does not, so such replies fall through to the wrap.
 */
export function parsePostJson(text: string): unknown {
  const cleaned = pyStrip(text.replace(THINK_RE, ''));
  for (const candidate of [cleaned, text]) {
    const direct = tryParse(candidate);
    if (direct.ok) return direct.value;

    if (candidate.includes('```')) {
      const m = FENCE_RE.exec(candidate);
      if (m) {
        const r = tryParse(pyStrip(m[1]!));
        if (r.ok) return r.value;
      }
    }

    const balanced = findBalancedJsonObject(candidate);
    if (balanced) {
      const r = tryParse(balanced);
      if (r.ok) return r.value;
    }
  }

  let content = cleaned ? cleaned : text;
  content = pyStrip(content.replace(ANY_FENCE_RE, ''));
  content = stripRoleMarkers(content);
  if (!pyStrip(content)) throw new Error('persona_post_empty_content');
  if (pyLen(content) > 4000) throw new Error('persona_post_content_too_long');
  return { post_type: 'post', content };
}

export async function generatePersonaPost(
  p: ProviderConfig,
  deps: ProviderDeps,
  req: { system: string; user: string; temperature: number; signal?: AbortSignal },
): Promise<Post> {
  const text = await generateText(p, deps, {
    system: req.system,
    user: req.user,
    temperature: req.temperature,
    maxTokens: 1024,
    signal: req.signal,
  });
  const parsed = parsePostJson(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('persona_post_not_an_object');
  }
  return parsed as Post;
}

export type Contradiction = 'supports' | 'contradicts' | 'extends';

export async function classifyContradiction(
  p: ProviderConfig,
  deps: ProviderDeps,
  a: string,
  b: string,
  signal?: AbortSignal,
): Promise<Contradiction> {
  const prompt = `Compare these two passages from academic papers and classify their relationship.

PASSAGE A:
${fenceUntrusted(a)}

PASSAGE B:
${fenceUntrusted(b)}

Respond with exactly one word: supports, contradicts, or extends

- supports: Passage B provides evidence for or agrees with Passage A's claims
- contradicts: Passage B disagrees with, challenges, or presents conflicting evidence to Passage A
- extends: Passage B builds on Passage A by adding new dimensions, caveats, or applications`;
  const text = await generateText(p, deps, {
    system: 'You are a precise academic text classifier. Respond with exactly one word.',
    user: prompt,
    temperature: 0.8,
    maxTokens: 1024,
    signal,
  });
  const result = pyStrip(text).toLowerCase().replace(/\.+$/, '');
  for (const word of ['supports', 'contradicts', 'extends'] as const) {
    if (result.includes(word)) return word;
  }
  return 'extends';
}

export async function classifyContradictionsBatch(
  p: ProviderConfig,
  deps: ProviderDeps,
  pairs: [string, string][],
  opts: { concurrency?: number; signal?: AbortSignal; logger: Logger },
): Promise<string[]> {
  return mapLimit(pairs, opts.concurrency ?? 5, async ([a, b]) => {
    try {
      return await classifyContradiction(p, deps, a, b, opts.signal);
    } catch (e) {
      opts.logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'contradiction_classify_failed');
      return 'error';
    }
  });
}

/** Python truthiness for a JSON value. */
function falsy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** Mutates and returns `post`; throws persona_post_missing_content when content is falsy. */
export function validatePostShape(post: Post, opts: { personaKey: string; logger: Logger }): Post {
  const { personaKey, logger } = opts;
  for (const field of REQUIRED_FIELDS) {
    if (falsy(post[field])) {
      logger.warn({ persona: personaKey, field, have: Object.keys(post) }, 'post_shape_missing_required_field');
      if (field === 'persona') post.persona = personaKey;
      else if (field === 'post_type') post.post_type = 'post';
      else throw new Error('persona_post_missing_content');
    }
  }

  let pt = post.post_type;
  if (typeof pt !== 'string' || !VALID_POST_TYPES.has(pt)) {
    logger.warn({ persona: personaKey, invalid_post_type: pt }, 'post_shape_invalid_post_type');
    post.post_type = 'post';
    pt = 'post';
  }

  if (pt === 'thread') {
    const tp = post.thread_posts;
    const valid = Array.isArray(tp) && tp.length > 0 && tp.every((x) => typeof x === 'string' && pyStrip(x) !== '');
    if (!valid) {
      logger.warn(
        {
          persona: personaKey,
          thread_posts_type: Array.isArray(tp) ? 'list' : tp === null ? 'NoneType' : typeof tp,
          thread_posts_len: Array.isArray(tp) ? tp.length : null,
        },
        'post_shape_invalid_thread_posts',
      );
      post.post_type = 'post';
      delete post.thread_posts;
      delete post.thread_count;
    }
  }

  const content = post.content;
  if (typeof content === 'string' && pyLen(content) > MAX_CONTENT_CHARS) {
    logger.warn(
      { persona: personaKey, original_length: pyLen(content), max_length: MAX_CONTENT_CHARS },
      'post_shape_content_truncated',
    );
    post.content = pySlice(content, 0, MAX_CONTENT_CHARS) + '…';
  }
  return post;
}
