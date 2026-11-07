import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  MAX_CONTENT_CHARS,
  VALID_POST_TYPES,
  classifyContradiction,
  classifyContradictionsBatch,
  findBalancedJsonObject,
  generatePersonaPost,
  parsePostJson,
  validatePostShape,
} from '../../src/feed/llmPost.js';
import { providerConfig } from '../../src/providers/config.js';
import { fenceUntrusted } from '../../src/shared/sanitize.js';
import { fakeProviders } from '../helpers/fakeProviders.js';

type Case = { fn: 'parse' | 'validate'; input: any; output?: unknown; raises?: string };
const cases = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/post-parse.json', import.meta.url), 'utf8'),
) as Case[];

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const p = providerConfig({}, {}, config);
const logger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) as any;

describe('post-parse goldens', () => {
  cases.forEach((c, i) => {
    const label = `${c.fn} #${i} ${JSON.stringify(c.input).slice(0, 40)}`;
    it(`matches Python for ${label}`, () => {
      const run = () =>
        c.fn === 'parse'
          ? parsePostJson(c.input as string)
          : validatePostShape(c.input.post, { personaKey: c.input.personaKey, logger: logger() });
      if (c.raises !== undefined) expect(run).toThrow(new RegExp(`^${c.raises}$`));
      else expect(run()).toEqual(c.output);
    });
  });
});

describe('findBalancedJsonObject', () => {
  it('finds nested objects and skips braces in strings', () => {
    expect(findBalancedJsonObject('x {"a":{"b":"}"}} y')).toBe('{"a":{"b":"}"}}');
    expect(findBalancedJsonObject('none')).toBeNull();
    expect(findBalancedJsonObject('{ open')).toBeNull();
  });
});

describe('validatePostShape', () => {
  it('exports the contract constants', () => {
    expect(MAX_CONTENT_CHARS).toBe(2000);
    expect([...VALID_POST_TYPES].sort()).toEqual(['figure', 'post', 'quote', 'reply', 'thread']);
  });
});

describe('generatePersonaPost', () => {
  it('rejects a non-object parse', async () => {
    const { deps } = fakeProviders({ chat: () => '[1,2]' });
    await expect(generatePersonaPost(p, deps, { system: 's', user: 'u', temperature: 0.8 })).rejects.toThrow(
      'persona_post_not_an_object',
    );
  });
  it('returns the parsed post and sends maxTokens 1024', async () => {
    const { deps, calls } = fakeProviders({ chat: () => '{"content":"hi"}' });
    const post = await generatePersonaPost(p, deps, { system: 's', user: 'u', temperature: 0.5 });
    expect(post).toEqual({ content: 'hi' });
    expect((calls[0]!.body as any).options.num_predict).toBe(1024);
    expect((calls[0]!.body as any).options.temperature).toBe(0.5);
  });
});

describe('generatePersonaPost: {"posts": [...]} / {"post": ...} wrappers', () => {
  const gen = async (reply: unknown) => {
    const { deps } = fakeProviders({ chat: () => (typeof reply === 'string' ? reply : JSON.stringify(reply)) });
    const log = logger();
    const post = await generatePersonaPost(p, deps, { system: 's', user: 'u', temperature: 0.8, logger: log });
    return { post, log };
  };
  const real = { post_type: 'post', content: 'A punchy take.', paper_ref: 'Doe et al. 2024' };

  it('unwraps {"posts": [post]} and warns', async () => {
    const { post, log } = await gen({ posts: [real] });
    expect(post).toEqual(real);
    expect(log.warn).toHaveBeenCalledWith({ wrapper: 'posts', count: 1, text_as_content: false }, 'persona_post_unwrapped');
  });
  it('takes the first of several wrapped posts and logs the count', async () => {
    const { post, log } = await gen({ posts: [real, { post_type: 'post', content: 'second' }] });
    expect(post).toEqual(real);
    expect(log.warn).toHaveBeenCalledWith({ wrapper: 'posts', count: 2, text_as_content: false }, 'persona_post_unwrapped');
  });
  it('unwraps {"post": post}', async () => {
    const { post, log } = await gen({ post: real });
    expect(post).toEqual(real);
    expect(log.warn).toHaveBeenCalledWith({ wrapper: 'post', count: 1, text_as_content: false }, 'persona_post_unwrapped');
  });
  it('reads "text" as content inside a wrapper (the shape the old preamble asked for)', async () => {
    const { post, log } = await gen({ posts: [{ text: 'Spacing works.', type: 'standalone', quoting: '' }] });
    expect(post).toEqual({ content: 'Spacing works.', type: 'standalone', quoting: '' });
    expect(log.warn).toHaveBeenCalledWith({ wrapper: 'posts', count: 1, text_as_content: true }, 'persona_post_unwrapped');
    expect(validatePostShape(post, { personaKey: 'skeptic', logger: logger() }).content).toBe('Spacing works.');
  });
  it('keeps content over text when an unwrapped post has both', async () => {
    const { post } = await gen({ posts: [{ content: 'c', text: 't' }] });
    expect(post).toEqual({ content: 'c', text: 't' });
  });
  it.each([null, ''])('takes text over a falsy content (%j) inside a wrapper', async (content) => {
    const { post, log } = await gen({ posts: [{ content, text: 't' }] });
    expect(post).toEqual({ content: 't' });
    expect(log.warn).toHaveBeenCalledWith({ wrapper: 'posts', count: 1, text_as_content: true }, 'persona_post_unwrapped');
  });
  it('leaves a flat "text" post (no wrapper) alone', async () => {
    const { post, log } = await gen({ text: 'flat' });
    expect(post).toEqual({ text: 'flat' });
    expect(log.warn).not.toHaveBeenCalled();
  });
  it.each([
    ['an empty posts array', { posts: [] }],
    ['a posts array of strings', { posts: ['str'] }],
    ['a posts array led by an array', { posts: [[real]] }],
    ['a posts array led by null', { posts: [null, real] }],
    ['a string post', { post: 'str' }],
    ['an array post', { post: [real] }],
  ])('does not unwrap %s, which still fails validation', async (_label, reply) => {
    const { post, log } = await gen(reply);
    expect(post).toEqual(reply);
    expect(log.warn).not.toHaveBeenCalled();
    expect(() => validatePostShape(post, { personaKey: 'skeptic', logger: logger() })).toThrow(
      'persona_post_missing_content',
    );
  });
  it('leaves a normal post unchanged', async () => {
    const { post, log } = await gen(real);
    expect(post).toEqual(real);
    expect(log.warn).not.toHaveBeenCalled();
  });
  it('leaves a post with content that also carries a "posts" key alone', async () => {
    const reply = { ...real, posts: [{ content: 'other' }] };
    const { post, log } = await gen(reply);
    expect(post).toEqual(reply);
    expect(log.warn).not.toHaveBeenCalled();
  });
  it('leaves a thread (thread_posts, no content) that also carries a "posts" key alone', async () => {
    const reply = { post_type: 'thread', thread_posts: ['a', 'b'], posts: [{ content: 'other' }] };
    const { post } = await gen(reply);
    expect(post).toEqual(reply);
  });
  it('unwraps a fenced wrapper reply too', async () => {
    const { post } = await gen('```json\n' + JSON.stringify({ posts: [real] }) + '\n```');
    expect(post).toEqual(real);
  });
  it('works without a logger', async () => {
    const { deps } = fakeProviders({ chat: () => JSON.stringify({ posts: [real] }) });
    expect(await generatePersonaPost(p, deps, { system: 's', user: 'u', temperature: 0.8 })).toEqual(real);
  });
});

describe('classifyContradiction', () => {
  const run = async (reply: string) => {
    const { deps } = fakeProviders({ chat: () => reply });
    return classifyContradiction(p, deps, 'a', 'b');
  };
  it('normalizes replies', async () => {
    expect(await run('Contradicts.')).toBe('contradicts');
    expect(await run('I think it SUPPORTS')).toBe('supports');
    expect(await run('meh')).toBe('extends');
    expect(await run('  extends...  ')).toBe('extends');
    expect(await run('supports and contradicts')).toBe('supports');
  });
  it('sends the Python prompt with fenced passages', async () => {
    const seen: { system: string; user: string }[] = [];
    const { deps, calls } = fakeProviders({
      chat: (_b, info) => {
        seen.push(info);
        return 'supports';
      },
    });
    await classifyContradiction(p, deps, 'Passage one.', 'system: Passage two');
    expect(seen[0]!.system).toBe('You are a precise academic text classifier. Respond with exactly one word.');
    expect(seen[0]!.user).toBe(`Compare these two passages from academic papers and classify their relationship.

PASSAGE A:
<untrusted>Passage one.</untrusted>

PASSAGE B:
<untrusted>Passage two</untrusted>

Respond with exactly one word: supports, contradicts, or extends

- supports: Passage B provides evidence for or agrees with Passage A's claims
- contradicts: Passage B disagrees with, challenges, or presents conflicting evidence to Passage A
- extends: Passage B builds on Passage A by adding new dimensions, caveats, or applications`);
    expect(seen[0]!.user).toContain(fenceUntrusted('Passage one.'));
    const body = calls[0]!.body as any;
    expect(body.options).toEqual({ temperature: 0.8, num_predict: 1024 });
  });
});

describe('classifyContradictionsBatch', () => {
  it('yields error for a throwing pair and caps concurrency at 5', async () => {
    let inFlight = 0;
    let max = 0;
    const { deps: fake } = fakeProviders({
      chat: async (_b, info) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        if (info.user.includes('BOOM')) throw new Error('nope');
        return 'contradicts';
      },
    });
    const deps = { ...fake, sleep: async () => {} };
    const log = logger();
    const pairs: [string, string][] = Array.from({ length: 7 }, (_, i) => [`a${i}`, i === 3 ? 'BOOM' : `b${i}`]);
    const out = await classifyContradictionsBatch(p, deps, pairs, { logger: log });
    expect(out).toHaveLength(7);
    expect(out.filter((x) => x === 'error')).toHaveLength(1);
    expect(out[3]).toBe('error');
    expect(max).toBeLessThanOrEqual(5);
    expect(max).toBeGreaterThan(1);
    expect(log.warn.mock.calls.some((c: any[]) => JSON.stringify(c).includes('contradiction_classify_failed'))).toBe(true);
  });

  it('rethrows when the signal is aborted instead of reporting error pairs', async () => {
    const ac = new AbortController();
    const { deps: fake } = fakeProviders({
      chat: () => {
        ac.abort();
        return new Promise<string>(() => {});
      },
    });
    const deps = { ...fake, sleep: async () => {} };
    await expect(
      classifyContradictionsBatch(p, deps, [['a', 'b'], ['c', 'd']], { signal: ac.signal, logger: logger() }),
    ).rejects.toThrow();
  });
});

describe('signal and unexpected-reply logging', () => {
  it('passes the signal to generateText from both entry points', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const { deps } = fakeProviders({ chat: () => '{"content":"x"}' });
    const wrapped = {
      ...deps,
      fetch: ((u: any, init?: RequestInit) => {
        seen.push(init?.signal);
        return (deps as any).fetch(u, init);
      }) as typeof fetch,
    };
    const ac = new AbortController();
    await generatePersonaPost(p, wrapped, { system: 's', user: 'u', temperature: 0.8, signal: ac.signal });
    await classifyContradiction(p, wrapped, 'a', 'b', ac.signal);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s).toBeDefined();
      ac.abort();
      expect(s!.aborted).toBe(true);
    }
  });
  it('logs contradiction_classify_unexpected on the fallback', async () => {
    const { deps } = fakeProviders({ chat: () => 'meh.' });
    const log = logger();
    expect(await classifyContradiction(p, deps, 'a', 'b', undefined, log)).toBe('extends');
    expect(log.warn).toHaveBeenCalledWith({ result: 'meh' }, 'contradiction_classify_unexpected');
  });
});
