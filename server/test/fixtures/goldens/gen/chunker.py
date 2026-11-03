"""Write chunker goldens using worker/lib/chunker.py.

Usage: python -I chunker.py <chunker-inputs.json> <out-chunker.json>

Input: [{name, markdown, max_tokens}]. Output: [{name, chunks}]. structlog writes to stdout, so the result goes to a file.
"""

import json
import sys

sys.path[:0] = ["/src/worker", "/src/shared"]

from lib.chunker import chunk_markdown  # noqa: E402


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as f:
        cases = json.load(f)
    out = []
    for c in cases:
        try:
            chunks = chunk_markdown(c["markdown"], c["max_tokens"])
        except Exception as e:  # python's encode() raises on special-token strings
            print(f"{c['name']}: python raised {type(e).__name__}", file=sys.stderr)
            continue
        out.append({"name": c["name"], "chunks": chunks})
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
