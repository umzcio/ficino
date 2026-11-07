"""Record the worker's feed-audio text helpers and the Python string semantics the TS port copies.

Usage: python -I feed_audio.py <out-dir>
Writes <out-dir>/feed-audio.json:
  {speech: [{name, post, display_name, result}], titles: {s: s.title()}, persona_keys: [{value, key}],
   title_exceptions: {c: c.title()}, unidata_version, reclaim: [{time_limit, minutes}],
   attribute_errors: [{value, message}]}

`speech` runs the real `_post_to_speech_text(post, display_name)` from `tasks.audio_tasks` over synthetic posts;
`result` is the returned string, `null` for None, or `{"raises": "<Type>: <str(exc)>"}`. `titles` is `str.title()`
over a fixed list. `persona_keys` is `str(v or "")`, the persona key expression in `generate_audio_for_feed`.
`title_exceptions` maps every code point (surrogates excluded) whose `c.title()` differs from `c.upper()`.
`reclaim` is `_reclaim_minutes()` with `CELERY_TIME_LIMIT` set to each value. `attribute_errors` is `str(exc)` of the
`AttributeError` that `v.get("persona")` raises for each non-dict JSON value. All text is synthetic.
"""

import json
import os
import sys
import unicodedata

sys.path[:0] = [p for p in os.environ.get("PYTHONPATH", "").split(":") if p]

import tasks.audio_tasks as at  # noqa: E402

out = sys.argv[1]

WORDS = "The cohort effect held across every synthetic seminar we sampled"
SPACED_4100 = (WORDS + " ") * 70  # 4480 code points, spaces throughout
SPACED_4100 = SPACED_4100[:4100]
ASTRAL = "\U0001F600"

SPEECH = [
    ("plain", {"persona": "skeptic", "content": "  The effect held.  "}, "The Skeptic"),
    ("deleted", {"persona": "skeptic", "content": "Gone.", "deleted": True}, "The Skeptic"),
    ("deleted_falsy", {"persona": "skeptic", "content": "Kept.", "deleted": 0}, "The Skeptic"),
    ("whitespace_only", {"persona": "skeptic", "content": " \n\t　 "}, "The Skeptic"),
    ("content_missing", {"persona": "skeptic"}, "The Skeptic"),
    ("content_null", {"persona": "skeptic", "content": None}, "The Skeptic"),
    ("content_number", {"persona": "skeptic", "content": 5}, "The Skeptic"),
    (
        "thread_posts",
        {"content": "Head post.", "thread_posts": ["  Second part.  ", "   ", 7, None, "Third part."]},
        "Methods",
    ),
    ("thread_posts_not_list", {"content": "Head post.", "thread_posts": "not a list"}, "Methods"),
    ("empty_display_name", {"content": "No speaker cue."}, ""),
    ("long_with_spaces", {"content": SPACED_4100}, "The Skeptic"),
    ("long_without_space", {"content": "x" * 4100}, ""),
    ("astral_across_cut", {"content": "ab " + (ASTRAL * 3 + " ") * 1100}, "Hype"),
    ("astral_no_space_across_cut", {"content": ASTRAL * 4100}, ""),
]


def speech(name, post, display_name):
    try:
        result = at._post_to_speech_text(post, display_name)
    except Exception as e:  # noqa: BLE001
        result = {"raises": f"{type(e).__name__}: {e}"}
    return {"name": name, "post": post, "display_name": display_name, "result": result}


TITLES = [
    "my_persona", "o'neil", "émile zola", "ǆx", "ǅX", "x1y", "ßa", "ﬁx", "ŉx", "ªb", "ⓐb", "ⅰb",
    "ΑΣ ΑΣΑ", "ΑΣ.Α", "İx xİ", "skeptic", "", "custom_KEY 2nd", "ΑΣ'", "Σ",
]

title_exceptions = {}
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    c = chr(cp)
    if c.title() != c.upper():
        title_exceptions[c] = c.title()

reclaim = []
for t in (300, 600, 1800):
    os.environ["CELERY_TIME_LIMIT"] = str(t)
    reclaim.append({"time_limit": t, "minutes": at._reclaim_minutes()})

attribute_errors = []
for v in (None, "x", 1, 1.5, True, [1]):
    try:
        v.get("persona")
        raise AssertionError(f"{v!r} has .get")
    except AttributeError as e:
        attribute_errors.append({"value": v, "message": str(e)})

doc = {
    "speech": [speech(*c) for c in SPEECH],
    "titles": {s: s.title() for s in TITLES},
    "persona_keys": [{"value": v, "key": str(v or "")} for v in (None, False, 0, "", "x")],
    "title_exceptions": title_exceptions,
    "unidata_version": unicodedata.unidata_version,
    "reclaim": reclaim,
    "attribute_errors": attribute_errors,
}
with open(os.path.join(out, "feed-audio.json"), "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
    f.write("\n")
