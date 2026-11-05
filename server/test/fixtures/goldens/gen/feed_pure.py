"""Run the Python worker's pure persona helpers over fixed inputs.

Usage: python -I feed_pure.py <out-dir>
Writes <out-dir>/feed-pure.json (short_cite, sources, category, blend, enabled) and
<out-dir>/system-preamble.txt (SYSTEM_PREAMBLE, UTF-8, exactly).
get_personas is patched, so no database is touched.
"""

import json
import os
import sys

sys.path[:0] = [p for p in os.environ.get("PYTHONPATH", "").split(":") if p]

from lib import persona  # noqa: E402
from tasks.preference_tasks import PREFERENCE_BLEND  # noqa: E402

out = sys.argv[1]

KEYS = ["skeptic", "methodologist", "practitioner", "hype", "gradstudent", "archivist", "amplifier"]
POST_TYPES = ["post", "thread", "quote", "reply", "figure"]

FAKE = {
    k: {
        "handle": "@" + k, "name": k, "initials": k[:2], "color": "#000", "system_prompt": "p",
        "temperature": None, "retrieval_query": None, "allowed_figure_types": None,
        "feed_eligible": k != "archivist",
    }
    for k in KEYS
}
persona.get_personas = lambda: FAKE


def chunk(**kw):
    base = {"id": "c1", "paper_id": "p1", "section": "Methods", "content": "text", "score": 0.5}
    base.update(kw)
    return base


short_cite_chunks = [
    chunk(paper_authors=[], paper_title="Empty Authors", paper_year=2020),
    chunk(paper_authors=["Unknown"], paper_title="Unknown Author Paper", paper_year=2021),
    chunk(paper_authors=["Unknown Authors"], paper_title="Unknown Authors Paper", paper_year=None),
    chunk(paper_authors=["Jane Smith"], paper_title="T", paper_year=2024),
    chunk(paper_authors=["Jane Smith"], paper_title="T", paper_year=None),
    chunk(paper_authors=["Jane Smith", "Bob Jones"], paper_title="T", paper_year=2023),
    chunk(paper_authors=["Jane Smith", "Bob Jones"], paper_title="T", paper_year=None),
    chunk(paper_authors=[], paper_title=None, paper_filename="paper.pdf", paper_year=2019),
    chunk(paper_authors=[], paper_title=None, paper_filename="paper.pdf", paper_year=None),
    chunk(paper_authors=["José Müller-Łukasiewicz"], paper_title="T", paper_year=2022),
    chunk(paper_authors=["Ann  de   la Cruz"], paper_title="T", paper_year=2018),
]
short_cite = [{"chunk": c, "expected": persona._build_short_cite(c)} for c in short_cite_chunks]

long_content = "a" * 295 + "\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600 tail"
src_chunks = [
    chunk(id="c1", content=long_content, score=0.12345, paper_title="Long"),
    chunk(id="c2", paper_title=None, paper_filename="fallback.pdf", score=0.9995),
    chunk(id="c3", paper_title="Third", score=0.0005, section=None),
    chunk(id="c4", paper_title="Fourth", score=1),
    chunk(id="c5", paper_title="Fifth", score=0.2857142),
    chunk(id="c6", paper_title="Sixth"),
    chunk(id="c7", paper_title="Seventh"),
]
sources = [
    {"chunks": src_chunks, "top_n": 5, "expected": persona.build_post_sources(src_chunks, 5)},
    {"chunks": src_chunks[:2], "top_n": 5, "expected": persona.build_post_sources(src_chunks[:2], 5)},
]

category = [
    {"persona": k, "post_type": t, "expected": persona.assign_post_category(k, t)}
    for k in KEYS + ["nobody"] for t in POST_TYPES
]

blend_inputs = [
    ({"post": 0.35, "thread": 0.10, "quote": 0.20, "reply": 0.25, "figure": 0.10},
     {"post": 0.1, "thread": 0.1, "quote": 0.1, "reply": 0.1, "figure": 0.6}),
    ({"a": 0.5, "b": 0.5}, {"b": 0.2, "c": 0.8, "d": 0.0}),
    ({k: 1.0 / 5 for k in KEYS[:5]}, {"skeptic": 0.7, "hype": 0.3, "ghost": 0.5}),
]
blend = [
    {"manual": m, "learned": l, "blend": PREFERENCE_BLEND, "expected": persona._blend_weights(m, l, PREFERENCE_BLEND)}
    for m, l in blend_inputs
]

enabled = [
    {"settings": s, "expected": sorted(persona.resolve_enabled_personas(s))}
    for s in [{}, {"personas_enabled": None}, {"personas_enabled": {"hype": False}},
              {"personas_enabled": {"hype": True, "skeptic": False, "archivist": True}}]
]

with open(os.path.join(out, "feed-pure.json"), "w", encoding="utf-8") as f:
    json.dump(
        {"preference_blend": PREFERENCE_BLEND, "personas": KEYS, "short_cite": short_cite, "sources": sources,
         "category": category, "blend": blend, "enabled": enabled},
        f, ensure_ascii=False, indent=1,
    )
    f.write("\n")
with open(os.path.join(out, "system-preamble.txt"), "w", encoding="utf-8", newline="") as f:
    f.write(persona.SYSTEM_PREAMBLE)
