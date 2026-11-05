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
});
