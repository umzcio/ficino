import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { closePdf, openPdf, type PdfDoc } from '../../src/ingest/pdf.js';
import type { ProviderDeps } from '../../src/providers/deps.js';
import { providerConfig } from '../../src/providers/config.js';
import { extractWithVision, isVisionAvailable } from '../../src/providers/vision.js';

// Port of worker/tests/test_wave3_task_fixes.py (R10 WORK-9 vision retry tests).
const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const ollama = providerConfig({ vision_provider: 'ollama', ollama_vision_model: 'vis-model' }, {}, config);
const api = (key: string) => providerConfig({ vision_provider: 'api', anthropic_api_key: key, claude_model: 'claude-x' }, {}, config);

const SAMPLE = new Uint8Array(readFileSync(new URL('../fixtures/sample.pdf', import.meta.url).pathname));
let doc: PdfDoc;
beforeAll(() => {
  doc = openPdf(SAMPLE);
});
afterAll(() => closePdf(doc));

type Step = Response | Error;
function fakeDeps(steps: Step[], extra: Partial<ProviderDeps> = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  const deps: ProviderDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      const s = steps.shift();
      if (!s) throw new Error('no more fake responses');
      if (s instanceof Error) throw s;
      return s;
    }) as typeof fetch,
    anthropic: () => {
      throw new Error('unexpected anthropic');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  };
  return { deps, calls, sleeps };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (content: string) => json({ message: { content } });

describe('isVisionAvailable', () => {
  it('api needs a key; ollama needs a model; others are unavailable', () => {
    expect(isVisionAvailable(api('k'))).toBe(true);
    expect(isVisionAvailable(api(''))).toBe(false);
    expect(isVisionAvailable(ollama)).toBe(true);
    expect(isVisionAvailable({ ...ollama, vision: { ...ollama.vision, ollamaModel: '' } })).toBe(false);
    expect(isVisionAvailable(providerConfig({ vision_provider: 'bogus' }, {}, config))).toBe(false);
  });
});

describe('extractWithVision: ollama', () => {
  it('retries transient failures: 2 connection errors then success (test_ollama_page_extract_retries_transient_failures)', async () => {
    const { deps, calls, sleeps } = fakeDeps([new TypeError('blip'), new TypeError('blip'), ok('page text')]);
    expect(await extractWithVision(doc, ollama, deps, 1)).toBe('page text');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
  });
  it('wire shape: system prompt, per-page user text, base64 png image, stream false', async () => {
    const { deps, calls } = fakeDeps([ok('x')]);
    await extractWithVision(doc, ollama, deps, 1);
    const b = calls[0]!.body as { model: string; stream: boolean; messages: Array<Record<string, unknown>> };
    expect(calls[0]!.url).toBe('http://fake-ollama:11434/api/chat');
    expect(b.model).toBe('vis-model');
    expect(b.stream).toBe(false);
    expect(String(b.messages[0]!.content)).toMatch(/^You are an academic paper text extractor\./);
    expect(b.messages[1]!.content).toBe('Extract all text from page 1 as structured markdown.');
    const img = Buffer.from((b.messages[1]!.images as string[])[0]!, 'base64');
    expect([...img.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(img.readUInt32BE(16)).toBe(1700); // 8.5in * 200dpi
  });
  it('a 5xx is retried; a 4xx is not', async () => {
    const a = fakeDeps([json({}, 503), ok('fine')]);
    expect(await extractWithVision(doc, ollama, a.deps, 1)).toBe('fine');
    const b = fakeDeps([json({}, 404), ok('never')]);
    await expect(extractWithVision(doc, ollama, b.deps, 1)).rejects.toThrow('HTTP 404');
    expect(b.calls).toHaveLength(1);
  });
  it('gives up after 3 attempts', async () => {
    const { deps, calls } = fakeDeps([json({}, 500), json({}, 500), json({}, 500), ok('never')]);
    await expect(extractWithVision(doc, ollama, deps, 1)).rejects.toThrow('HTTP 500');
    expect(calls).toHaveLength(3);
  });
  it('empty or blank content throws and is not retried', async () => {
    const { deps, calls } = fakeDeps([ok('  \n'), ok('never')]);
    await expect(extractWithVision(doc, ollama, deps, 1)).rejects.toThrow(
      "ollama vision model 'vis-model' returned empty content for page 1",
    );
    expect(calls).toHaveLength(1);
  });
  it('stops at maxPages and joins pages with the markdown separator', async () => {
    const { deps, calls } = fakeDeps([ok('one'), ok('two'), ok('three')]);
    expect(await extractWithVision(doc, ollama, deps, 2)).toBe('one\n\n---\n\ntwo');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages).toMatchObject([{}, { content: 'Extract all text from page 2 as structured markdown.' }]);
  });
  it('covers every page when maxPages exceeds the page count', async () => {
    const { deps, calls } = fakeDeps([ok('a'), ok('b'), ok('c'), ok('d')]);
    expect(await extractWithVision(doc, ollama, deps, 100)).toBe('a\n\n---\n\nb\n\n---\n\nc');
    expect(calls).toHaveLength(3);
  });
  it('throws when no provider is available', async () => {
    const { deps } = fakeDeps([]);
    await expect(extractWithVision(doc, api(''), deps, 1)).rejects.toThrow(
      'No vision provider available (set OLLAMA_VISION_MODEL or ANTHROPIC_API_KEY)',
    );
  });
  it('a job abort is not retried and propagates', async () => {
    const ac = new AbortController();
    const { deps, calls } = fakeDeps([]);
    deps.fetch = (async () => {
      calls.push({ url: '', body: {} });
      ac.abort(new Error('cancelled'));
      throw new TypeError('aborted');
    }) as typeof fetch;
    await expect(extractWithVision(doc, ollama, deps, 3, ac.signal)).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe('extractWithVision: claude', () => {
  const conn = () => new Anthropic.APIConnectionError({ message: 'blip' });
  function claudeDeps(failures: unknown[], text = 'page text') {
    const created: Array<{ key: string; opts: unknown }> = [];
    const params: Array<Record<string, unknown>> = [];
    const f = fakeDeps([], {
      anthropic: (key, opts) => {
        created.push({ key, opts });
        return {
          messages: {
            create: async (p) => {
              params.push(p);
              const e = failures.shift();
              if (e) throw e;
              return { content: [{ type: 'text', text }] };
            },
          },
        };
      },
    });
    return { ...f, created, params };
  }

  it('retries connection errors: 2 failures then success (test_claude_page_extract_retries_transient_failures)', async () => {
    const { deps, params, sleeps } = claudeDeps([conn(), conn()]);
    expect(await extractWithVision(doc, api('sk'), deps, 1)).toBe('page text');
    expect(params).toHaveLength(3);
    expect(sleeps).toEqual([2000, 6000]);
  });
  it('retries 429 and 5xx, by SDK class or by status shape', async () => {
    const rate = new Anthropic.RateLimitError(429, {}, 'slow down', new Headers());
    const { deps, params } = claudeDeps([rate, Object.assign(new Error('overloaded'), { status: 529 })]);
    expect(await extractWithVision(doc, api('sk'), deps, 1)).toBe('page text');
    expect(params).toHaveLength(3);
  });
  it('does not retry a 400/401', async () => {
    const { deps, params } = claudeDeps([Object.assign(new Error('bad'), { status: 400 })]);
    await expect(extractWithVision(doc, api('sk'), deps, 1)).rejects.toThrow('bad');
    expect(params).toHaveLength(1);
  });
  it('gives up after 3 attempts and rethrows the last error', async () => {
    const { deps, params } = claudeDeps([conn(), conn(), conn(), conn()]);
    await expect(extractWithVision(doc, api('sk'), deps, 1)).rejects.toThrow('blip');
    expect(params).toHaveLength(3);
  });
  it('pins SDK retries off: the client is created with maxRetries 0 (test_claude_vision_client_pins_sdk_retries_off)', async () => {
    const { deps, created } = claudeDeps([]);
    await extractWithVision(doc, api('sk-9'), deps, 1);
    expect(created).toHaveLength(1);
    expect(created[0]!.key).toBe('sk-9');
    expect(created[0]!.opts).toMatchObject({ maxRetries: 0 });
  });
  it('request shape: model, 2048 tokens, system prompt, image + text', async () => {
    const { deps, params } = claudeDeps([]);
    await extractWithVision(doc, api('sk'), deps, 1);
    const p = params[0]!;
    expect(p).toMatchObject({ model: 'claude-x', max_tokens: 2048 });
    expect(String(p.system)).toMatch(/^You are an academic paper text extractor\./);
    const content = (p.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(content[1]).toEqual({ type: 'text', text: 'Extract all text from page 1 as structured markdown.' });
  });
});
