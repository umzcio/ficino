"""Render the Python worker's metadata and contextualizer prompts for a fixed sample.

Usage: python -I metadata_prompt.py <sample.txt> <out-dir>
Writes <out-dir>/metadata-prompt.txt (the user prompt extract_metadata sends) and
<out-dir>/contextualizer-prompts.json (system prompt, Ollama user prompt, Anthropic paper block and user text).
"""

import json
import os
import sys

sys.path[:0] = [p for p in os.environ.get("PYTHONPATH", "").split(":") if p]

from lib.contextualizer import SYSTEM_PROMPT, _build_user_prompt  # noqa: E402
from lib.metadata_extractor import METADATA_PROMPT  # noqa: E402
from lib.sanitize import fence_untrusted  # noqa: E402

sample = open(sys.argv[1], encoding="utf-8").read()
out = sys.argv[2]

with open(os.path.join(out, "metadata-prompt.txt"), "w", encoding="utf-8") as f:
    f.write(METADATA_PROMPT.format(text=fence_untrusted(sample[:2000])))

chunk = "The ablation removes the reranker.\nResults drop {a lot}."
paper = sample[:600]
doc = {
    "system": SYSTEM_PROMPT,
    "paper": paper,
    "chunk": chunk,
    "ollama_user": _build_user_prompt(paper, chunk),
    "anthropic_paper_block": f"<paper>\n{paper}\n</paper>",
    "anthropic_user": f"<excerpt>\n{chunk}\n</excerpt>\n\nWrite the contextual prefix for the excerpt.",
}
with open(os.path.join(out, "contextualizer-prompts.json"), "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
