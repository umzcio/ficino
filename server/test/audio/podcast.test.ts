import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  buildPodcastScript,
  collectPaperIds,
  fallbackScript,
  fitTotalChars,
  formatChunksForPodcast,
  MAX_TOTAL_CHARS,
  MIN_SEGMENTS,
  parseScript,
  PODCAST_QUERY,
  PODCAST_SYSTEM_PROMPT,
  personaName,
  RETRIEVAL_TOP_K,
  summarizeFeedForPrompt,
  TARGET_SEGMENTS,
  type Segment,
} from '../../src/audio/podcast.js';
import { loadConfig } from '../../src/config.js';
import type { RetrievalCtx } from '../../src/feed/retrieval.js';
import type { Chunk, Persona, Personas, Post } from '../../src/feed/types.js';
import { providerConfig } from '../../src/providers/config.js';
import { fakeProviders, type ChatInfo } from '../helpers/fakeProviders.js';

// Plan 05 Task 7: src/audio/podcast.ts pinned to podcast-script.json, produced by the real worker/lib/podcast.py
// (gen/podcast_script.py): every pure helper, and buildPodcastScript through its retrieve/fetchTitles seams with the
// fake providers' chat answering the case's raw text.

type GoldenCase = {
  name: string;
  input: {
    posts: unknown[];
    chunks: Chunk[];
    title_rows: Array<{ id: string; title: string | null }>;
    raw: string | null;
    llm_raises: string | null;
    retrieve_raises: string | null;
    titles_raise: string | null;
  };
  retrieve_calls: Array<{ query: string; paper_ids: string[]; top_k: number; kwargs: Record<string, unknown> }>;
  fetch_calls: Array<{ sql: string; args: unknown[] }>;
  llm_calls: Array<{ system: string; user: string; kwargs: { temperature: number; max_tokens: number } }>;
  logs: Array<{ level: string; event: string; kwargs: Record<string, unknown> }>;
  pure: {
    paper_ids: string[];
    feed_block: string;
    chunks_block: string;
    parsed: Segment[] | null;
    fitted: Segment[] | null;
    paper_titles: string[];
    fallback: Segment[];
  };
  result: Segment[] | { raises: string };
};

type Golden = {
  system_prompt: string;
  constants: { min_segments: number; target_segments: number; max_total_chars: number; retrieval_top_k: number };
  personas: Record<string, Omit<Persona, 'key'>>;
  cases: GoldenCase[];
  persona_names: Array<{ post: Post; name: string }>;
  parse_extra: Array<{ raw: string; parsed: Segment[] | null }>;
  fit_extra: Array<{ segments: Segment[]; cap: number; fitted: Segment[] }>;
};

const golden = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/podcast-script.json', import.meta.url), 'utf8'),
) as Golden;

const personas: Personas = new Map(Object.entries(golden.personas).map(([key, p]) => [key, { key, ...p }]));
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });

/** The chunks the Python builder saw: none without paper ids or when retrieval raised. */
const seenChunks = (c: GoldenCase): Chunk[] =>
  c.pure.paper_ids.length === 0 || c.input.retrieve_raises ? [] : c.input.chunks;

describe('podcast constants', () => {
  it('match lib/podcast.py', () => {
    expect(PODCAST_SYSTEM_PROMPT).toBe(golden.system_prompt);
    expect({
      min_segments: MIN_SEGMENTS,
      target_segments: TARGET_SEGMENTS,
      max_total_chars: MAX_TOTAL_CHARS,
      retrieval_top_k: RETRIEVAL_TOP_K,
    }).toEqual(golden.constants);
    const withRetrieval = golden.cases.find((c) => c.retrieve_calls.length > 0)!;
    expect(PODCAST_QUERY).toBe(withRetrieval.retrieve_calls[0]!.query);
  });

  it('carries the fake providers podcast marker', () => {
    expect(PODCAST_SYSTEM_PROMPT).toContain('You are a podcast producer writing a short episode');
  });
});

describe.each(golden.cases.map((c) => [c.name, c] as const))('golden case %s', (_name, c) => {
  it('pure helpers', () => {
    const { posts } = c.input;
    expect(collectPaperIds(posts)).toEqual(c.pure.paper_ids);
    expect(summarizeFeedForPrompt(posts, personas)).toBe(c.pure.feed_block);
    expect(formatChunksForPodcast(seenChunks(c))).toBe(c.pure.chunks_block);
    if (c.input.raw !== null) {
      const parsed = parseScript(c.input.raw);
      expect(parsed).toEqual(c.pure.parsed);
      expect(parsed ? fitTotalChars(parsed) : null).toEqual(c.pure.fitted);
    }
    expect(fallbackScript(posts, personas, seenChunks(c), c.pure.paper_titles)).toEqual(c.pure.fallback);
  });

  it('buildPodcastScript through the seams', async () => {
    const lines: Array<Record<string, unknown> & { msg: string }> = [];
    const logger = pino({ level: 'debug' }, { write: (x: string) => void lines.push(JSON.parse(x)) });
    const infos: ChatInfo[] = [];
    // An LLM failure is an empty answer: generateText throws `LLM returned empty response` without retry sleeps.
    const f = fakeProviders({
      chat: (_b, info) => {
        infos.push(info);
        return c.input.llm_raises ? '' : c.input.raw!;
      },
    });
    const rctx: RetrievalCtx = {
      sql: undefined as never,
      config,
      providers: providerConfig({}, {}, config),
      deps: f.deps,
      logger,
    };
    const retrieved: Array<{ query: string; paperIds: string[]; topK: number }> = [];
    const titled: string[][] = [];
    const got = await buildPodcastScript(rctx, {
      posts: structuredClone(c.input.posts),
      personas,
      logger,
      retrieve: async (q) => {
        retrieved.push(q);
        if (c.input.retrieve_raises) throw new Error(c.input.retrieve_raises);
        return structuredClone(c.input.chunks);
      },
      fetchTitles: async (ids) => {
        titled.push(ids);
        if (c.input.titles_raise) throw new Error(c.input.titles_raise);
        return structuredClone(c.input.title_rows);
      },
    });

    expect(got).toEqual(c.result);
    expect(retrieved).toEqual(c.retrieve_calls.map((r) => ({ query: r.query, paperIds: r.paper_ids, topK: r.top_k })));
    expect(titled).toEqual(c.fetch_calls.map((r) => r.args[0]));
    expect(infos.map((i) => ({ purpose: i.purpose, system: i.system, user: i.user }))).toEqual(
      c.llm_calls.map((l) => ({ purpose: 'podcast', system: golden.system_prompt, user: l.user })),
    );
    for (const [i, l] of c.llm_calls.entries()) {
      expect(infos[i]!.temperature).toBe(l.kwargs.temperature);
      expect(infos[i]!.maxTokens).toBe(l.kwargs.max_tokens);
    }

    const events = lines.filter((l) => l.msg.startsWith('podcast_'));
    expect(events.map((l) => l.msg)).toEqual(c.logs.map((l) => l.event));
    for (const [i, l] of c.logs.entries()) {
      const line = events[i]!;
      // LLM error text differs by construction (the fake answers ''); every other field is Python's.
      const keys = Object.keys(l.kwargs).filter((k) => !(l.event === 'podcast_llm_failed' && k.startsWith('error')));
      for (const k of keys) expect([l.event, k, line[k]]).toEqual([l.event, k, l.kwargs[k]]);
    }
  });
});

describe('personaName', () => {
  it.each(golden.persona_names.map((p) => [JSON.stringify(p.post), p] as const))('%s', (_n, p) => {
    expect(personaName(p.post, personas)).toBe(p.name);
  });
});

describe('parseScript extras', () => {
  it.each(golden.parse_extra.map((p) => [JSON.stringify(p.raw), p] as const))('%s', (_n, p) => {
    expect(parseScript(p.raw)).toEqual(p.parsed);
  });
});

describe('fitTotalChars extras', () => {
  it.each(golden.fit_extra.map((f, i) => [i, f] as const))('case %i', (_i, f) => {
    const input = structuredClone(f.segments);
    expect(fitTotalChars(input, f.cap)).toEqual(f.fitted);
    expect(input).toEqual(f.segments);
  });

  it('defaults the cap to MAX_TOTAL_CHARS', () => {
    const segs: Segment[] = [0, 1, 2].map((i) => ({ speaker: 'host_a', text: 'z'.repeat(600 + i) }));
    expect(fitTotalChars(segs)).toHaveLength(2);
  });
});
