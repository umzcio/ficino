import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  detectFiguresOnPage,
  FIGURE_TYPES,
  isFigureDetectAvailable,
  parseDetectorResponse,
} from '../../src/providers/figureDetect.js';
import { providerConfig } from '../../src/providers/config.js';
import type { ProviderDeps } from '../../src/providers/deps.js';

const config = loadConfig({ OLLAMA_BASE_URL: 'http://fake-ollama:11434' });
const cfg = (s: Record<string, unknown>) => providerConfig(s, {}, config);
const fig = (o: Record<string, unknown> = {}) => ({ bbox: [0.1, 0.1, 0.6, 0.6], type: 'chart_bar', ...o });
const resp = (figures: unknown[]) => JSON.stringify({ figures });

describe('parseDetectorResponse', () => {
  it('strict JSON', () => {
    const out = parseDetectorResponse(
      resp([fig({ caption: 'Fig. 1', figure_number: '1', data_claim: 'c', referenced_paragraph: 'p', confidence: 0.9 })]),
    );
    expect(out).toEqual([
      { bbox: [0.1, 0.1, 0.6, 0.6], type: 'chart_bar', caption: 'Fig. 1', figure_number: '1', data_claim: 'c', referenced_paragraph: 'p', confidence: 0.9 },
    ]);
  });
  it('defaults: empty strings and confidence 0.5', () => {
    expect(parseDetectorResponse(resp([fig()]))[0]).toMatchObject({ caption: '', figure_number: '', data_claim: '', referenced_paragraph: '', confidence: 0.5 });
  });
  it('fenced JSON (with and without language tag, with prose around)', () => {
    expect(parseDetectorResponse('```json\n' + resp([fig()]) + '\n```')).toHaveLength(1);
    expect(parseDetectorResponse('Here you go:\n```\n' + resp([fig()]) + '\n```\nDone.')).toHaveLength(1);
  });
  it('prose and non-figure JSON give []', () => {
    expect(parseDetectorResponse('I see two figures on this page.')).toEqual([]);
    expect(parseDetectorResponse('{"figures": "none"}')).toEqual([]);
    expect(parseDetectorResponse('[1,2]')).toEqual([]);
    expect(parseDetectorResponse('')).toEqual([]);
  });
  it('drops non-object entries and malformed bboxes', () => {
    expect(parseDetectorResponse(resp([1, 'x', null, { type: 'chart_bar' }, { bbox: [0, 0, 1] }, { bbox: 'abc' }, { bbox: [0, 0, 'a', 1] }, { bbox: [0, 0, null, 1] }]))).toEqual([]);
  });
  it('accepts numeric-string bbox entries like float()', () => {
    expect(parseDetectorResponse(resp([{ bbox: ['0.1', ' 0.1 ', '0.7', '0.7'] }]))[0]!.bbox).toEqual([0.1, 0.1, 0.7, 0.7]);
  });
  it('clamps overshoot to the unit square', () => {
    expect(parseDetectorResponse(resp([{ bbox: [-0.2, 0.1, 1.02, 0.9] }]))[0]!.bbox).toEqual([0, 0.1, 1, 0.9]);
  });
  it('drops x1 <= x0 and y1 <= y0', () => {
    expect(parseDetectorResponse(resp([{ bbox: [0.6, 0.1, 0.6, 0.9] }, { bbox: [0.7, 0.1, 0.2, 0.9] }, { bbox: [0.1, 0.9, 0.9, 0.2] }]))).toEqual([]);
  });
  it('area threshold: 0.004 dropped, 0.006 kept', () => {
    expect(parseDetectorResponse(resp([{ bbox: [0, 0, 0.1, 0.04] }]))).toEqual([]);
    expect(parseDetectorResponse(resp([{ bbox: [0, 0, 0.1, 0.06] }]))).toHaveLength(1);
  });
  it('type aliases map; unknown types become other; case and whitespace are normalized', () => {
    const t = (type: unknown) => parseDetectorResponse(resp([fig({ type })]))[0]!.type;
    expect(t('scatterplot')).toBe('chart_scatter');
    expect(t('table')).toBe('table_image');
    expect(t('Histogram')).toBe('chart_bar');
    expect(t('  Flowchart ')).toBe('flowchart');
    expect(t('banana')).toBe('other');
    expect(t(null)).toBe('other');
    expect(t(undefined)).toBe('other');
    for (const ft of FIGURE_TYPES) expect(t(ft)).toBe(ft);
  });
  it('caps text fields in code points', () => {
    const astral = '😀';
    const out = parseDetectorResponse(
      resp([fig({ caption: astral.repeat(2500), figure_number: 'x'.repeat(50), data_claim: 'd'.repeat(1500), referenced_paragraph: astral.repeat(2100) })]),
    )[0]!;
    expect([...out.caption]).toHaveLength(2000);
    expect(out.figure_number).toHaveLength(40);
    expect(out.data_claim).toHaveLength(1000);
    expect([...out.referenced_paragraph]).toHaveLength(2000);
  });
  it('confidence: non-numeric becomes 0.5, out of range is clamped', () => {
    const c = (confidence: unknown) => parseDetectorResponse(resp([fig({ confidence })]))[0]!.confidence;
    expect(c('x')).toBe(0.5);
    expect(c(null)).toBe(0.5);
    expect(c(3)).toBe(1);
    expect(c(-2)).toBe(0);
    expect(c('0.25')).toBe(0.25);
  });
  it('non-string text fields are str()-ed', () => {
    const out = parseDetectorResponse(resp([fig({ figure_number: 5, caption: null })]))[0]!;
    expect(out.figure_number).toBe('5');
    expect(out.caption).toBe('None');
  });
});

describe('isFigureDetectAvailable', () => {
  it('anthropic needs a key, ollama needs a model, none is off', () => {
    expect(isFigureDetectAvailable(cfg({ figure_detect_provider: 'anthropic', anthropic_api_key: 'k' }))).toBe(true);
    expect(isFigureDetectAvailable(cfg({ figure_detect_provider: 'anthropic', anthropic_api_key: '' }))).toBe(false);
    expect(isFigureDetectAvailable(cfg({ figure_detect_provider: 'ollama', figure_detect_ollama_model: 'm' }))).toBe(true);
    const noModel = cfg({ figure_detect_provider: 'ollama' });
    expect(isFigureDetectAvailable({ ...noModel, figureDetect: { ...noModel.figureDetect, ollamaModel: '' } })).toBe(false);
    expect(isFigureDetectAvailable(cfg({ figure_detect_provider: 'none' }))).toBe(false);
  });
});

describe('detectFiguresOnPage', () => {
  const png = new Uint8Array([1, 2, 3]);
  const mk = (extra: Partial<ProviderDeps> = {}) => {
    const calls: Array<{ url: string; body: Record<string, any>; signal?: AbortSignal | null }> = [];
    const deps: ProviderDeps = {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
        return new Response(JSON.stringify({ message: { content: resp([fig()]) } }), { status: 200 });
      }) as typeof fetch,
      anthropic: () => {
        throw new Error('unexpected anthropic');
      },
      sleep: async () => {},
      ...extra,
    };
    return { deps, calls };
  };

  it('ollama: posts the page and parses the reply; falls back to thinking', async () => {
    const { deps, calls } = mk();
    const p = cfg({ figure_detect_provider: 'ollama', figure_detect_ollama_model: 'qwen-vl' });
    const out = await detectFiguresOnPage(p, deps, png, 3, 'x'.repeat(9000));
    expect(out).toHaveLength(1);
    const b = calls[0]!.body;
    expect(calls[0]!.url).toBe('http://fake-ollama:11434/api/chat');
    expect(b).toMatchObject({ model: 'qwen-vl', stream: false, think: false, options: { temperature: 0 } });
    expect(b.messages[1].images).toEqual([Buffer.from(png).toString('base64')]);
    expect(b.messages[1].content).toContain('This is page 3 of a scientific paper.');
    expect(b.messages[1].content).toContain('<page_text>\n' + 'x'.repeat(8000) + '\n</page_text>');
    expect(b.messages[0].content).toMatch(/^You identify the scientific figures on one page/);

    const th = mk({
      fetch: (async () => new Response(JSON.stringify({ message: { content: '', thinking: resp([fig(), fig()]) } }))) as typeof fetch,
    });
    expect(await detectFiguresOnPage(p, th.deps, png, 1, '')).toHaveLength(2);
  });

  it('anthropic: model, temperature 0, 2048 tokens, joins text blocks, default SDK retries', async () => {
    const seen: Array<{ key: string; opts: unknown; params: Record<string, any>; callOpts: unknown }> = [];
    const text = resp([fig()]);
    const { deps } = mk({
      anthropic: (key, opts) => ({
        messages: {
          create: async (params, callOpts) => {
            seen.push({ key, opts, params, callOpts });
            return { content: [{ type: 'text', text: text.slice(0, 10) }, { type: 'tool_use' }, { type: 'text', text: text.slice(10) }] };
          },
        },
      }),
    });
    const ac = new AbortController();
    const p = cfg({ figure_detect_provider: 'anthropic', anthropic_api_key: 'sk', figure_detect_anthropic_model: 'claude-x' });
    expect(await detectFiguresOnPage(p, deps, png, 2, 'txt', ac.signal)).toHaveLength(1);
    expect(seen[0]!.key).toBe('sk');
    expect(seen[0]!.opts).not.toHaveProperty('maxRetries');
    expect(seen[0]!.params).toMatchObject({ model: 'claude-x', max_tokens: 2048, temperature: 0 });
    expect(seen[0]!.params.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(seen[0]!.callOpts).toEqual({ signal: ac.signal });
  });

  it('none, unknown provider and missing key return [] without calling anything', async () => {
    const { deps, calls } = mk();
    for (const s of [{ figure_detect_provider: 'none' }, { figure_detect_provider: 'bogus' }, { figure_detect_provider: 'anthropic', anthropic_api_key: '' }])
      expect(await detectFiguresOnPage(cfg(s), deps, png, 1, '')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('provider errors return [] (HTTP error, network error, unparseable body)', async () => {
    const p = cfg({ figure_detect_provider: 'ollama', figure_detect_ollama_model: 'm' });
    const bad = (f: typeof fetch) => mk({ fetch: f }).deps;
    expect(await detectFiguresOnPage(p, bad((async () => new Response('no', { status: 500 })) as typeof fetch), png, 1, '')).toEqual([]);
    expect(await detectFiguresOnPage(p, bad((async () => { throw new TypeError('down'); }) as typeof fetch), png, 1, '')).toEqual([]);
    expect(await detectFiguresOnPage(p, bad((async () => new Response('{}', { status: 200 })) as typeof fetch), png, 1, '')).toEqual([]);
  });

  it('a job-signal abort rethrows instead of returning []', async () => {
    const ac = new AbortController();
    const p = cfg({ figure_detect_provider: 'ollama', figure_detect_ollama_model: 'm' });
    const { deps } = mk({
      fetch: (async () => {
        ac.abort(new Error('cancelled'));
        throw new DOMException('aborted', 'AbortError');
      }) as typeof fetch,
    });
    await expect(detectFiguresOnPage(p, deps, png, 1, '', ac.signal)).rejects.toBeDefined();
    const pa = cfg({ figure_detect_provider: 'anthropic', anthropic_api_key: 'k' });
    const ac2 = new AbortController();
    const d2 = mk({
      anthropic: () => ({
        messages: { create: async () => { ac2.abort(new Error('cancelled')); throw new Error('aborted'); } },
      }),
    }).deps;
    await expect(detectFiguresOnPage(pa, d2, png, 1, '', ac2.signal)).rejects.toBeDefined();
  });
});
