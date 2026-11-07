/**
 * ElevenLabs text-to-speech: a port of `worker/lib/tts.py`, and the only code that talks to ElevenLabs.
 *
 * `speak` renders one text in one voice (feed audio, one file per post). `speakDialogue` renders a whole multi-speaker
 * script in ONE `text-to-dialogue` call, so the episode is one continuous render with cross-speaker prosody. It never
 * splits a script: a script over the cap throws `DialogueTooLongError` before any request. Neither call is retried,
 * as in Python. Every request goes through `deps.fetch`.
 */
import type { Config } from '../config.js';
import { pyLen, pyStrip } from '../shared/pystr.js';
import type { ProviderDeps } from './deps.js';
import { fetchBytes } from './http.js';

const TTS_API = 'https://api.elevenlabs.io/v1/text-to-speech';
const DIALOGUE_API = 'https://api.elevenlabs.io/v1/text-to-dialogue';

/** Python's httpx `timeout=30.0` / `180.0`, here a total deadline per request (deliberate change 15). */
export const TTS_TIMEOUT_MS = 30_000;
export const DIALOGUE_TIMEOUT_MS = 180_000;

/** Eleven v3's per-request text cap, counted in code points (Python `len`). */
export const DIALOGUE_CHAR_CAP = 2000;

/** Rachel: the voice for any key not in `VOICE_MAP` (custom personas). */
export const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

/** persona key -> ElevenLabs preset voice id. A code-level decision, never a user setting. */
export const VOICE_MAP: Readonly<Record<string, string>> = Object.freeze({
  skeptic: 'AZnzlk1XvdvUeBnXmlld', // Domi
  methodologist: '1Hdh5sdoicm1xyz0gQhD', // Liz
  practitioner: '3nDq4c7a9Pk3q5rxbMJH', // Matthew
  hype: 'JBFqnCBsd6RMkjVDRZzb', // George
  gradstudent: 'PzuBz8h2SxBvQ7lnUC44', // Gregory
  archivist: 'pFZP5JQG7iQjIQuC4Bku', // Lily
  amplifier: 'MjDkeH2x9hCiWKXZtUPc', // Marcos
  // Podcast hosts: narrator voices, not personas.
  host_a: 'q0IMILNRPxOgtBTS4taI', // Drew
  host_b: 'rPMkKgdwgIwqv4fXgR6N', // Tyler
});

/** `voice_id_for`: `VOICE_MAP.get(key, _DEFAULT_VOICE)`. Own keys only, so `constructor` is not a voice. */
export function voiceIdFor(key: string): string {
  return Object.hasOwn(VOICE_MAP, key) ? VOICE_MAP[key]! : DEFAULT_VOICE;
}

export type TtsConfig = { apiKey: string; modelId: string; dialogueModelId: string };

/** The operator's ElevenLabs settings. The key is env only (`ELEVENLABS_API_KEY`), stripped as `tts.py` does. */
export function ttsConfig(config: Config): TtsConfig {
  return {
    apiKey: pyStrip(config.elevenlabsApiKey),
    modelId: config.elevenlabsModelId,
    dialogueModelId: config.elevenlabsDialogueModelId,
  };
}

/** `TTSUnavailable`: no key. The caller fails the whole job. */
export class TtsUnavailableError extends Error {
  constructor() {
    super('ELEVENLABS_API_KEY is not set');
    this.name = 'TtsUnavailableError';
  }
}

/** `DialogueTooLong`: the script is over the per-request cap. Never split; the podcast fails. */
export class DialogueTooLongError extends Error {
  constructor(readonly total: number) {
    super(`dialogue exceeds ${DIALOGUE_CHAR_CAP}-char cap: ${total}`);
    this.name = 'DialogueTooLongError';
  }
}

function headers(apiKey: string): Record<string, string> {
  return { 'xi-api-key': apiKey, accept: 'audio/mpeg', 'content-type': 'application/json' };
}

/** `synthesize`: one text in one voice -> mp3 bytes. */
export async function speak(
  cfg: TtsConfig,
  deps: Pick<ProviderDeps, 'fetch'>,
  req: { text: string; voiceId: string; signal?: AbortSignal },
): Promise<Uint8Array> {
  if (!cfg.apiKey) throw new TtsUnavailableError();
  return fetchBytes(deps, `${TTS_API}/${req.voiceId}`, {
    method: 'POST',
    headers: headers(cfg.apiKey),
    body: {
      text: req.text,
      model_id: cfg.modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    timeoutMs: TTS_TIMEOUT_MS,
    signal: req.signal,
  });
}

export type DialogueInput = { text: string; voice_id: string };

/**
 * `synthesize_dialogue`: every turn in ONE request -> one continuous mp3. In `tts.py`'s order, the key check runs
 * first, then the cap check, both before any request.
 */
export async function speakDialogue(
  cfg: TtsConfig,
  deps: Pick<ProviderDeps, 'fetch'>,
  req: { inputs: DialogueInput[]; signal?: AbortSignal },
): Promise<Uint8Array> {
  if (!cfg.apiKey) throw new TtsUnavailableError();
  // `len(turn.get("text") or "")`
  const total = req.inputs.reduce((n, turn) => n + pyLen(turn.text || ''), 0);
  if (total > DIALOGUE_CHAR_CAP) throw new DialogueTooLongError(total);
  return fetchBytes(deps, DIALOGUE_API, {
    method: 'POST',
    headers: headers(cfg.apiKey),
    body: { inputs: req.inputs, model_id: cfg.dialogueModelId, settings: { stability: 0.5 } },
    timeoutMs: DIALOGUE_TIMEOUT_MS,
    signal: req.signal,
  });
}
