"""Write PyMuPDF goldens for a PDF (or every PDF in a directory) using worker/lib/pdf_extractor.py.

Usage: python -I pdf_text.py <pdf-or-dir> <out-dir>

For each <name>.pdf it writes:
  <name>.pymupdf.md   extract_text_pymupdf(path), UTF-8, byte for byte
  <name>.pages.json   extract_pages_text(path)
  <name>.raster.json  per page at 150 dpi (rasterize_pages): {width, height, probes: [{x, y, rgb}]}
"""

import json
import os
import sys
from pathlib import Path

# `python -I` ignores PYTHONPATH, so apply the one the docker command sets (the read-only repo mounts).
sys.path[:0] = [p for p in os.environ.get("PYTHONPATH", "").split(":") if p]

import fitz  # noqa: E402
from lib.pdf_extractor import (  # noqa: E402
    extract_pages_text,
    extract_text_pymupdf,
    get_page_count,
    rasterize_pages,
)

# Device-pixel probe positions at 150 dpi. On sample.pdf page 2, three of them fall inside chart bars.
PROBES = [(10, 10), (500, 950), (615, 850), (730, 900), (1200, 1600)]


def raster(path: str) -> list[dict]:
    pages = []
    for png in rasterize_pages(path, range(get_page_count(path)), dpi=150):
        pix = fitz.Pixmap(png)
        probes = [
            {"x": x, "y": y, "rgb": list(pix.pixel(x, y)[:3])}
            for x, y in PROBES
            if x < pix.width and y < pix.height
        ]
        pages.append({"width": pix.width, "height": pix.height, "probes": probes})
    return pages


def write_goldens(pdf: Path, out: Path) -> None:
    stem = pdf.stem
    (out / f"{stem}.pymupdf.md").write_bytes(extract_text_pymupdf(str(pdf)).encode("utf-8", "surrogatepass"))
    with open(out / f"{stem}.pages.json", "w", encoding="utf-8") as f:
        json.dump(extract_pages_text(str(pdf)), f, ensure_ascii=True, indent=2)
        f.write("\n")
    with open(out / f"{stem}.raster.json", "w", encoding="utf-8") as f:
        json.dump(raster(str(pdf)), f, indent=2)
        f.write("\n")


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    pdfs = sorted(src.glob("*.pdf")) if src.is_dir() else [src]
    for pdf in pdfs:
        write_goldens(pdf, out)
        print(f"wrote goldens for {pdf.name}")


if __name__ == "__main__":
    main()
