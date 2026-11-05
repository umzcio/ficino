import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  dmChunksText,
  dmPlan,
  interjectionPlan,
  mentionedHandles,
  mentionPlan,
  replyChunksText,
  replyMainPlan,
  zapPlan,
  type ConvoMessage,
  type LlmPlan,
  type PersonaRow,
} from '../../src/conversations/prompts.js';

type Call = { system: string; messages: unknown[]; max_tokens: number; temperature: number };
type Case = {
  name: string;
  kind: 'dm' | 'reply' | 'zap';
  input: Record<string, any>;
  calls: Call[];
  rng_calls: number;
  response: Record<string, any>;
};
const cases = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/conversation-prompts.json', import.meta.url), 'utf8'),
) as Case[];

const asCall = (p: LlmPlan): Call => ({
  system: p.system,
  messages: p.messages,
  max_tokens: p.maxTokens,
  temperature: p.temperature,
});

const fakeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

describe('conversation prompt goldens', () => {
  for (const c of cases.filter((x) => x.kind === 'dm')) {
    it(`DM matches Python for ${c.name}`, () => {
      const i = c.input;
      const history: ConvoMessage[] = [...i.existing, { role: 'user', content: i.message }];
      const plan = dmPlan(i.persona, dmChunksText(i.chunks), history);
      expect([asCall(plan)]).toEqual(c.calls);
    });
  }

  for (const c of cases.filter((x) => x.kind === 'reply')) {
    it(`reply matches Python for ${c.name}`, () => {
      const i = c.input;
      const b = i.body;
      const personas = i.personas as PersonaRow[];
      const history: ConvoMessage[] = [...i.existing, { role: 'user', content: b.user_message }];
      const chunksText = replyChunksText(i.chunks);
      const plans: LlmPlan[] = [
        replyMainPlan({ personaPrompt: i.persona_prompt, postContent: b.post_content, chunksText, history }),
      ];
      const metas: unknown[] = [];
      const handles = mentionedHandles(b.user_message);
      for (const h of handles) {
        const mentioned = personas.find((p) => p.handle === `@${h}` && p.key !== b.persona_key);
        if (!mentioned) continue;
        const plan = mentionPlan({ mentioned, history, postContent: b.post_content, chunksText });
        plans.push(plan);
        metas.push(plan.meta);
      }
      let rngCalls = 0;
      const logger = fakeLogger();
      if (handles.length === 0 && history.filter((m) => m.role === 'user').length >= 2) {
        const rng = () => {
          rngCalls++;
          return i.random as number;
        };
        const candidates = personas.filter((p) => p.key !== b.persona_key);
        const plan = interjectionPlan(rng, { candidates, history, postContent: b.post_content, chunksText }, logger);
        if (plan) {
          plans.push(plan);
          metas.push(plan.meta);
        }
      }
      expect(plans.map(asCall)).toEqual(c.calls);
      expect(rngCalls).toBe(c.rng_calls);
      const strip = ({ content: _content, ...meta }: Record<string, unknown>) => meta;
      const expectedMetas = c.response.interjections ?? (c.response.interjection ? [c.response.interjection] : []);
      expect(metas).toEqual(expectedMetas.map(strip));
      if (c.name === 'reply-null-retrieval-query') {
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0]![1]).toBe('interjection_prepare_failed');
      } else {
        expect(logger.warn).not.toHaveBeenCalled();
      }
    });
  }

  for (const c of cases.filter((x) => x.kind === 'zap')) {
    it(`zap matches Python for ${c.name}`, () => {
      const i = c.input;
      const b = i.body;
      const plan = zapPlan({
        target: i.target,
        sourceName: i.source ? i.source.name : b.source_persona_key,
        history: i.existing,
        postContent: b.post_content,
        sourceMessage: b.source_message,
        chunksText: replyChunksText(i.chunks),
      });
      expect([asCall(plan)]).toEqual(c.calls);
    });
  }

  it('covers every kind and case the brief lists', () => {
    expect(cases.filter((c) => c.kind === 'dm')).toHaveLength(4);
    expect(cases.filter((c) => c.kind === 'zap')).toHaveLength(4);
    expect(cases.filter((c) => c.kind === 'reply').length).toBeGreaterThanOrEqual(8);
    for (const kind of ['dm', 'reply', 'zap']) {
      const fenced = cases.some(
        (c) => c.kind === kind && c.calls.some((x) => JSON.stringify(x).includes('&lt;/untrusted&gt;')),
      );
      expect(fenced).toBe(true);
    }
  });
});

describe('interjectionPlan', () => {
  const row = (key: string, q: string | null): PersonaRow => ({
    key,
    name: key,
    handle: `@${key}`,
    system_prompt: 'p',
    retrieval_query: q,
  });
  const history: ConvoMessage[] = [{ role: 'user', content: 'Alpha beta' }];
  const o = (candidates: PersonaRow[]) => ({ candidates, history, postContent: 'post', chunksText: '' });

  it('returns null without calling the rng when there are no candidates or none counts', () => {
    const rng = vi.fn(() => 0);
    expect(interjectionPlan(rng, o([]))).toBeNull();
    expect(interjectionPlan(rng, o([row('x', 'alpha, zzz')]))).toBeNull();
    expect(rng).not.toHaveBeenCalled();
  });

  it('counts an empty term as a hit, as Python does', () => {
    const plan = interjectionPlan(() => 0, o([row('x', 'alpha,')]));
    expect(plan?.meta.persona_key).toBe('x');
  });

  it('skips above 0.7 and fires at 0.7, calling the rng exactly once', () => {
    const rng = vi.fn(() => 0.70001);
    expect(interjectionPlan(rng, o([row('x', 'alpha, beta')]))).toBeNull();
    expect(rng).toHaveBeenCalledTimes(1);
    expect(interjectionPlan(() => 0.7, o([row('x', 'alpha, beta')]))).not.toBeNull();
  });

  it('returns null and logs when any candidate has a null retrieval_query', () => {
    const logger = fakeLogger();
    const rng = vi.fn(() => 0);
    expect(interjectionPlan(rng, o([row('x', 'alpha, beta'), row('y', null)]), logger)).toBeNull();
    expect(rng).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![1]).toBe('interjection_prepare_failed');
  });
});

describe('mentionedHandles', () => {
  it('matches Unicode word characters like Python \\w', () => {
    expect(mentionedHandles('@Ünïcode_1 x')).toEqual(['Ünïcode_1']);
  });

  it('matches mid-word, as findall does', () => {
    expect(mentionedHandles('a@b')).toEqual(['b']);
  });

  it('dedupes in first-seen order (case-sensitively) and keeps the first 3', () => {
    expect(mentionedHandles('@x @x @X @y @z @w')).toEqual(['x', 'X', 'y']);
    expect(mentionedHandles('no handles @ here')).toEqual([]);
  });
});
