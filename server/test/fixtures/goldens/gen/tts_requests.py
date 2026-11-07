"""Record the HTTP requests the worker's ElevenLabs client makes, without any network.

Usage: python -I tts_requests.py <out-dir>
Writes <out-dir>/tts-requests.json:
  {requests: [{name, env, call, url, headers, json, timeout}], voices: {key: id}, default_voice,
   too_long: "<raised message>", too_long_requests, unavailable: "<raised message>"}

`httpx.Client` in `lib.tts` is replaced by a recorder that answers every POST with fake mp3 bytes, then the real
`synthesize` and `synthesize_dialogue` run per case with `ELEVENLABS_API_KEY` set to a fixed fake key padded with
whitespace (the client strips it). The stripped key is written as `<key>`. `env` is the model-id overrides the case
sets (none means both unset, so the defaults apply); `call` is the function and its arguments. `voices` is
`voice_id_for` over every `VOICE_MAP` key plus `custom_x`. `too_long` is the message of the `DialogueTooLong` that a
2001-code-point dialogue raises, and `too_long_requests` the number of requests it made (0). `unavailable` is the
`TTSUnavailable` message for an empty key. All text is synthetic.
"""

import json
import os
import sys

sys.path[:0] = [p for p in os.environ.get("PYTHONPATH", "").split(":") if p]

import lib.tts as tts  # noqa: E402

out = sys.argv[1]

FAKE_KEY = "golden-fake-key-0000"
recorded = []


class FakeResponse:
    content = b"ID3fake"

    def raise_for_status(self):
        return None


class RecordingClient:
    def __init__(self, *, timeout):
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, *, headers, json):
        recorded.append({"url": url, "headers": dict(headers), "json": json, "timeout": self.timeout})
        return FakeResponse()


tts.httpx.Client = RecordingClient

MODEL_VARS = ("ELEVENLABS_MODEL_ID", "ELEVENLABS_DIALOGUE_MODEL_ID")


def set_env(env):
    os.environ["ELEVENLABS_API_KEY"] = "  " + FAKE_KEY + "\n"
    for k in MODEL_VARS:
        os.environ.pop(k, None)
    os.environ.update(env)


def redact(req):
    assert req["headers"]["xi-api-key"] == FAKE_KEY
    req["headers"]["xi-api-key"] = "<key>"
    return req


# 1000 astral characters are 2000 UTF-16 units but 1000 code points; Python's len() counts code points.
ASTRAL = "\U0001F600"
EXACT = [
    {"text": ASTRAL * 1000, "voice_id": tts.voice_id_for("host_a")},
    {"text": "é" * 999 + ".", "voice_id": tts.voice_id_for("host_b")},
]
OVER = [EXACT[0], {"text": EXACT[1]["text"] + "!", "voice_id": EXACT[1]["voice_id"]}]

CASES = [
    {
        "name": "tts_unicode",
        "env": {},
        "call": {"fn": "synthesize", "text": "Café results \U0001F9EA hold up.", "voice_id": tts.voice_id_for("skeptic")},
    },
    {
        "name": "tts_unknown_persona_model_override",
        "env": {"ELEVENLABS_MODEL_ID": "eleven_custom_tts"},
        "call": {"fn": "synthesize", "text": "A custom persona speaks.", "voice_id": tts.voice_id_for("custom_x")},
    },
    {
        "name": "dialogue_two_turns",
        "env": {},
        "call": {
            "fn": "synthesize_dialogue",
            "inputs": [
                {"text": "Welcome back. [laughs] Two papers today.", "voice_id": tts.voice_id_for("host_a")},
                {"text": "Both on synthetic seminars, naïvely.", "voice_id": tts.voice_id_for("host_b")},
            ],
        },
    },
    {
        "name": "dialogue_model_override",
        "env": {"ELEVENLABS_DIALOGUE_MODEL_ID": "eleven_custom_dialogue"},
        "call": {"fn": "synthesize_dialogue", "inputs": [{"text": "One turn.", "voice_id": tts.voice_id_for("host_a")}]},
    },
    {"name": "dialogue_exactly_2000", "env": {}, "call": {"fn": "synthesize_dialogue", "inputs": EXACT}},
]


def run(case):
    set_env(case["env"])
    before = len(recorded)
    call = case["call"]
    if call["fn"] == "synthesize":
        assert tts.synthesize(call["text"], call["voice_id"]) == b"ID3fake"
    else:
        assert tts.synthesize_dialogue(call["inputs"]) == b"ID3fake"
    assert len(recorded) == before + 1
    return {"name": case["name"], "env": case["env"], "call": call, **redact(recorded[-1])}


requests = [run(c) for c in CASES]

set_env({})
before = len(recorded)
try:
    tts.synthesize_dialogue(OVER)
    raise AssertionError("2001 code points did not raise")
except tts.DialogueTooLong as e:
    too_long = str(e)
too_long_requests = len(recorded) - before

os.environ["ELEVENLABS_API_KEY"] = "   "
try:
    tts.synthesize("x", tts.voice_id_for("skeptic"))
    raise AssertionError("empty key did not raise")
except tts.TTSUnavailable as e:
    unavailable = str(e)

doc = {
    "requests": requests,
    "voices": {k: tts.voice_id_for(k) for k in [*tts.VOICE_MAP, "custom_x"]},
    "default_voice": tts._DEFAULT_VOICE,
    "too_long": too_long,
    "too_long_requests": too_long_requests,
    "too_long_inputs": OVER,
    "unavailable": unavailable,
}
with open(os.path.join(out, "tts-requests.json"), "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
