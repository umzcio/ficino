import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractMetadata } from '../../src/ingest/metadata.js';
import { providerConfig } from '../../src/providers/config.js';
import { loadConfig } from '../../src/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';

const gold = (f: string) => readFileSync(new URL(`../fixtures/goldens/${f}`, import.meta.url), 'utf8');
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const p = providerConfig({}, {}, config);

function fake(reply: string | Error) {
  const bodies: Array<Record<string, unknown>> = [];
  const deps: ProviderDeps = {
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify({ message: { content: reply } }), { status: 200 });
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected');
    },
    sleep: async () => {},
  };
  return { deps, bodies };
}
const run = (reply: string) => extractMetadata(p, fake(reply).deps, 'x');

describe('extractMetadata', () => {
  it('sends the rendered Python prompt, system string and sampling options', async () => {
    const { deps, bodies } = fake('{}');
    await extractMetadata(p, deps, gold('metadata-sample.txt'));
    const msgs = bodies[0]!.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({
      role: 'system',
      content: 'You are a precise metadata extractor. Respond with only valid JSON.',
    });
    expect(msgs[1]!.content).toBe(gold('metadata-prompt.txt'));
    expect(bodies[0]!.options).toEqual({ temperature: 0.8, num_predict: 1024 });
  });

  it('parses fenced JSON and think tags', async () => {
    const r = await run(
      '<think>hmm {x}</think>\n```json\n{"title":"T","authors":[" A ","",null,"B"],"year":2024,"doi":"10.1/x","tags":["ML"," NLP "]}\n```',
    );
    expect(r).toEqual({ title: 'T', authors: ['A', 'B'], year: 2024, doi: '10.1/x', tags: ['ml', 'nlp'] });
  });

  it('garbage gives nulls, empty lists', async () => {
    const empty = { title: null, authors: [], year: null, doi: null, tags: [] };
    expect(await run('no json here')).toEqual(empty);
    expect(await run('{broken')).toEqual(empty);
    const { deps } = fake(new Error('boom'));
    expect(await extractMetadata(p, deps, 'x')).toEqual(empty);
  });

  it('keeps at most 3 tags', async () => {
    expect((await run('{"tags":["a","b","c","d","e"]}')).tags).toEqual(['a', 'b', 'c']);
  });

  it('year: string coerces, non-numeric and out-of-range drop', async () => {
    expect((await run('{"year":"2024"}')).year).toBe(2024);
    expect((await run('{"year":2019.9}')).year).toBe(2019);
    expect((await run('{"year":"circa 2024"}')).year).toBeNull();
    expect((await run('{"year":21}')).year).toBeNull();
    expect((await run('{"year":30000}')).year).toBeNull();
    expect((await run('{"year":null}')).year).toBeNull();
  });

  it('doi "null" and empty title become null', async () => {
    const r = await run('{"title":"","doi":"null"}');
    expect(r.title).toBeNull();
    expect(r.doi).toBeNull();
  });

  it('a job abort rejects instead of falling back', async () => {
    const ac = new AbortController();
    const { deps } = fake(
      Object.assign(new Error('aborted'), {
        name: 'AbortError',
      }),
    );
    ac.abort(new Error('cancelled'));
    await expect(extractMetadata(p, deps, 'x', ac.signal)).rejects.toThrow();
  });
});
