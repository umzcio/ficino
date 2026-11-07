import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HttpStatusError } from '../../src/providers/http.js';
import {
  DEFAULT_VOICE,
  DIALOGUE_CHAR_CAP,
  DIALOGUE_TIMEOUT_MS,
  DialogueTooLongError,
  speak,
  speakDialogue,
  TTS_TIMEOUT_MS,
  ttsConfig,
  TtsUnavailableError,
  VOICE_MAP,
  voiceIdFor,
  type DialogueInput,
  type TtsConfig,
} from '../../src/providers/speak.js';
import { fakeProviders } from '../helpers/fakeProviders.js';

type GoldenRequest = {
  name: string;
  env: Record<string, string>;
  call:
    | { fn: 'synthesize'; text: string; voice_id: string }
    | { fn: 'synthesize_dialogue'; inputs: DialogueInput[] };
  url: string;
  headers: Record<string, string>;
  json: unknown;
  timeout: number;
};
const golden = JSON.parse(
  readFileSync(new URL('../fixtures/goldens/tts-requests.json', import.meta.url), 'utf8'),
) as {
  requests: GoldenRequest[];
  voices: Record<string, string>;
  default_voice: string;
  too_long: string;
  too_long_requests: number;
  too_long_inputs: DialogueInput[];
  unavailable: string;
};

const FAKE_KEY = 'golden-fake-key-0000';

type Seen = { url: string; init: RequestInit; body: any };
function recorder(handler: (s: Seen) => Response | Promise<Response> = () => new Response(new Uint8Array([0x49, 0x44, 0x33]))) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const s = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? 'null')) };
    seen.push(s);
    return handler(s);
  }) as typeof fetch;
  return { deps: { fetch: fetchFn }, seen };
}

const cfgFor = (env: Record<string, string> = {}, key = `  ${FAKE_KEY}\n`): TtsConfig =>
  ttsConfig(loadConfig({ ELEVENLABS_API_KEY: key, ...env }));
const cfg = cfgFor();
const noKey: TtsConfig = { ...cfg, apiKey: '' };
const turns = (...texts: string[]): DialogueInput[] => texts.map((text, i) => ({ text, voice_id: i % 2 ? 'B' : 'A' }));

describe('golden requests (worker/lib/tts.py)', () => {
  it('covers the planned cases', () => {
    expect(golden.requests.map((r) => r.name)).toEqual([
      'tts_unicode',
      'tts_unknown_persona_model_override',
      'dialogue_two_turns',
      'dialogue_model_override',
      'dialogue_exactly_2000',
    ]);
  });

  for (const r of golden.requests) {
    it(`${r.name}: URL, headers and JSON body match`, async () => {
      const { deps, seen } = recorder();
      const c = cfgFor(r.env);
      const out =
        r.call.fn === 'synthesize'
          ? await speak(c, deps, { text: r.call.text, voiceId: r.call.voice_id })
          : await speakDialogue(c, deps, { inputs: r.call.inputs });
      expect([...out]).toEqual([0x49, 0x44, 0x33]);
      expect(seen).toHaveLength(1);
      const s = seen[0]!;
      expect(s.url).toBe(r.url);
      expect(s.init.method).toBe('POST');
      const headers = { ...(s.init.headers as Record<string, string>) };
      expect(headers['xi-api-key']).toBe(FAKE_KEY);
      headers['xi-api-key'] = '<key>';
      expect(headers).toEqual(r.headers);
      expect(s.body).toEqual(r.json);
      expect(r.call.fn === 'synthesize' ? TTS_TIMEOUT_MS : DIALOGUE_TIMEOUT_MS).toBe(r.timeout * 1000);
    });
  }

  it('the voice map and the default voice equal the golden', () => {
    expect(DEFAULT_VOICE).toBe(golden.default_voice);
    for (const [key, id] of Object.entries(golden.voices)) expect(voiceIdFor(key)).toBe(id);
    expect({ ...VOICE_MAP, custom_x: DEFAULT_VOICE }).toEqual(golden.voices);
    expect(Object.isFrozen(VOICE_MAP)).toBe(true);
    // Not inherited Object.prototype keys.
    expect(voiceIdFor('constructor')).toBe(DEFAULT_VOICE);
    expect(voiceIdFor('toString')).toBe(DEFAULT_VOICE);
  });

  it('2001 code points throw the golden DialogueTooLongError with no request', async () => {
    const { deps, seen } = recorder();
    const err = await speakDialogue(cfg, deps, { inputs: golden.too_long_inputs }).catch((e) => e);
    expect(err).toBeInstanceOf(DialogueTooLongError);
    expect(err.message).toBe(golden.too_long);
    expect(seen).toHaveLength(golden.too_long_requests);
    expect(seen).toHaveLength(0);
  });
});

describe('the key', () => {
  it('ttsConfig strips the key and reads the model ids from Config', () => {
    expect(
      ttsConfig(
        loadConfig({
          ELEVENLABS_API_KEY: ' \tk-1 \n',
          ELEVENLABS_MODEL_ID: 'm-tts',
          ELEVENLABS_DIALOGUE_MODEL_ID: 'm-dlg',
        }),
      ),
    ).toEqual({ apiKey: 'k-1', modelId: 'm-tts', dialogueModelId: 'm-dlg' });
    expect(ttsConfig(loadConfig({}))).toEqual({
      apiKey: '',
      modelId: 'eleven_turbo_v2_5',
      dialogueModelId: 'eleven_v3',
    });
  });

  for (const key of ['', '   \n\t']) {
    it(`a key of ${JSON.stringify(key)} throws TtsUnavailableError before any request`, async () => {
      const { deps, seen } = recorder();
      const c = cfgFor({}, key);
      const e1 = await speak(c, deps, { text: 'x', voiceId: 'v' }).catch((e) => e);
      const e2 = await speakDialogue(c, deps, { inputs: turns('x') }).catch((e) => e);
      for (const e of [e1, e2]) {
        expect(e).toBeInstanceOf(TtsUnavailableError);
        expect(e.message).toBe(golden.unavailable);
      }
      expect(seen).toHaveLength(0);
    });
  }

  it('an empty key with a 2001-code-point dialogue throws TtsUnavailableError, not DialogueTooLongError', async () => {
    const { deps, seen } = recorder();
    const err = await speakDialogue(noKey, deps, { inputs: golden.too_long_inputs }).catch((e) => e);
    expect(err).toBeInstanceOf(TtsUnavailableError);
    expect(err).not.toBeInstanceOf(DialogueTooLongError);
    expect(seen).toHaveLength(0);
  });
});

describe('the dialogue cap (Review Focus 1)', () => {
  it('is 2000', () => expect(DIALOGUE_CHAR_CAP).toBe(2000));

  it('counts code points: 1001 astral characters (2002 UTF-16 units) are sent', async () => {
    const { deps, seen } = recorder();
    const text = '\u{1F600}'.repeat(1001);
    expect(text.length).toBe(2002);
    await speakDialogue(cfg, deps, { inputs: [{ text, voice_id: 'A' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.inputs).toEqual([{ text, voice_id: 'A' }]);
  });

  it('a 2000-code-point dialogue over many turns is exactly one text-to-dialogue request, inputs unchanged', async () => {
    const { deps, seen } = recorder();
    const inputs = turns(...Array.from({ length: 20 }, (_, i) => String(i % 10).repeat(100)));
    await speakDialogue(cfg, deps, { inputs });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-dialogue');
    expect(seen[0]!.body.inputs).toEqual(inputs);
  });

  it('2001 code points spread over turns throw with the total and no request', async () => {
    const { deps, seen } = recorder();
    const err = await speakDialogue(cfg, deps, { inputs: turns('a'.repeat(1000), 'é'.repeat(1000), '!') }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DialogueTooLongError);
    expect(err.message).toBe('dialogue exceeds 2000-char cap: 2001');
    expect(seen).toHaveLength(0);
  });
});

describe('failures', () => {
  it('a 401 throws HttpStatusError 401 carrying the body', async () => {
    const { deps } = recorder(() => new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 }));
    for (const call of [
      () => speak(cfg, deps, { text: 'x', voiceId: 'v' }),
      () => speakDialogue(cfg, deps, { inputs: turns('x') }),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(HttpStatusError);
      expect(err.status).toBe(401);
      expect(err.body).toBe('{"detail":{"status":"invalid_api_key"}}');
    }
  });

  it("the caller's abort rejects both calls", async () => {
    const hang = (s: Seen) =>
      new Promise<Response>((_, reject) => {
        const signal = s.init.signal!;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const { deps, seen } = recorder(hang);
    const ac = new AbortController();
    const p1 = speak(cfg, deps, { text: 'x', voiceId: 'v', signal: ac.signal }).catch((e) => e);
    const p2 = speakDialogue(cfg, deps, { inputs: turns('x'), signal: ac.signal }).catch((e) => e);
    const reason = new Error('job aborted');
    ac.abort(reason);
    expect(await p1).toBe(reason);
    expect(await p2).toBe(reason);
    expect(seen).toHaveLength(2);
  });

  it('an already-aborted signal rejects', async () => {
    const { deps } = recorder((s) => Promise.reject(s.init.signal!.reason));
    const reason = new Error('gone');
    const err = await speak(cfg, deps, { text: 'x', voiceId: 'v', signal: AbortSignal.abort(reason) }).catch((e) => e);
    expect(err).toBe(reason);
  });
});

describe('fakeProviders ElevenLabs branch', () => {
  it('records both calls with key, model, voice and url, and answers ID3fake + the body', async () => {
    const f = fakeProviders();
    const c = cfgFor();
    const tts = await speak(c, f.deps, { text: 'Hello', voiceId: voiceIdFor('skeptic') });
    const dlg = await speakDialogue(c, f.deps, { inputs: turns('Hi', 'Hey') });
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(dec(tts)).toBe('ID3fake:' + JSON.stringify(f.calls[0]!.body));
    expect(dec(dlg)).toBe('ID3fake:' + JSON.stringify(f.calls[1]!.body));
    expect(f.calls.map((x) => [x.kind, x.apiKey, x.model, x.url])).toEqual([
      ['elevenlabs-tts', FAKE_KEY, 'eleven_turbo_v2_5', `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_MAP.skeptic}`],
      ['elevenlabs-dialogue', FAKE_KEY, 'eleven_v3', 'https://api.elevenlabs.io/v1/text-to-dialogue'],
    ]);
  });

  it('passes each call to the tts option, which may answer bytes or a Response', async () => {
    const seen: Array<{ kind: string; voiceId?: string }> = [];
    const f = fakeProviders({
      tts: (call) => {
        seen.push({ kind: call.kind, voiceId: call.voiceId });
        return call.kind === 'elevenlabs-tts' ? new Uint8Array([1, 2]) : new Response('quota', { status: 429 });
      },
    });
    expect([...(await speak(cfg, f.deps, { text: 'x', voiceId: 'VOICE1' }))]).toEqual([1, 2]);
    const err = await speakDialogue(cfg, f.deps, { inputs: turns('x') }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect([err.status, err.body]).toEqual([429, 'quota']);
    expect(seen).toEqual([
      { kind: 'elevenlabs-tts', voiceId: 'VOICE1' },
      { kind: 'elevenlabs-dialogue', voiceId: undefined },
    ]);
  });
});
