"""Write extraction-quality goldens using worker/lib/quality_check.py.

Usage: python -I quality.py <sample.pymupdf.md> <out-quality.json>

The input texts are built here; the output [{text, ok, reason}] carries each text so the TS test reads the same strings.
"""

import json
import sys

sys.path[:0] = ["/src/worker", "/src/shared"]

from lib.quality_check import check_extraction_quality  # noqa: E402

ENGLISH = (
    "The study examines how students allocate attention across multiple sources while reading academic papers. "
    "Participants completed a series of tasks, and their responses were coded by two independent raters. "
    "Results indicate that careful reading strategies improve comprehension, although the effect varies by domain. "
)


def texts(sample: str) -> list[str]:
    return [
        ENGLISH * 3,
        "",
        "   \n\t ",
        "too short to matter",
        ENGLISH[:199],
        ("§¶†‡•◊∑∏√∞≈≠±×÷ " * 40),
        ("�" * 15 + " " + ENGLISH),
        ("�" * 10 + " " + ENGLISH),
        ("\x01\x02\x03\x0b\x0c\x0e\x1f" * 3 + ENGLISH),
        ("Это тестовый текст на русском языке для проверки качества извлечения. " * 8),
        ("Let α, β, γ, δ ∈ Θ and σ² = Σ(xᵢ − μ)² / (n − 1) where ∇f(θ) → ∂L/∂θ. " * 8),
        ("这是一个用于测试提取质量的中文文本，没有空格分隔单词。" * 20),
        ("a" * 400),
        ("ab " * 200),
        ("x " * 200),
        ("supercalifragilisticexpialidocious" * 3 + " ") * 12,
        ("abc " * 100 + "wxyz " * 60),
        ("😀 " * 120 + ENGLISH),
        ("The  quick brown　fox jumps over the lazy dog near the riverbank today. " * 6),
        ("Mostly fine text with some symbols ★☆♥♦ " * 12),
        ("{[(" * 80 + "ok " * 30),
        sample,
    ]


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as f:
        sample = f.read()
    out = []
    for t in texts(sample):
        ok, reason = check_extraction_quality(t)
        out.append({"text": t, "ok": ok, "reason": reason})
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
