# PyMuPDF goldens

`pdf_text.py` runs the Python worker's own extractor (`worker/lib/pdf_extractor.py`, PyMuPDF 1.28.0 in the
`ficino-worker` image) on a PDF, or on every PDF in a directory, and writes for each `<name>.pdf`:

| File | Contents |
| --- | --- |
| `<name>.pymupdf.md` | `extract_text_pymupdf(path)`, UTF-8, byte for byte |
| `<name>.pages.json` | `extract_pages_text(path)` |
| `<name>.raster.json` | per page at 150 dpi (`rasterize_pages`): `width`, `height` and the RGB at 5 fixed pixels |

`test/ingest/pdf.test.ts` pins `src/ingest/pdf.ts` to these files for `test/fixtures/sample.pdf`.

## Regenerate

The fixture is built by `test/fixtures/build-sample-pdf.ts` (from `server/`: `npx tsx test/fixtures/build-sample-pdf.ts`).
Then, from the repo root:

```bash
docker run --rm --user 10001 --network none \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker \
  -e PYTHONPATH=/src/worker:/src/shared \
  ficino-worker python -I /fx/goldens/gen/pdf_text.py /fx/sample.pdf /fx/goldens
```

The image runs as uid 10001, so make `server/test/fixtures/goldens` writable for it first (for example
`chmod 777` it, then restore the mode and ownership afterwards). `python -I` ignores `PYTHONPATH`, so the
script adds those entries to `sys.path` itself.

## Comparing real papers (manual, not in CI)

Write both outputs outside the repo, because uploaded papers are private and this repo is public:

```bash
C=<scratch>/extract-compare   # PDFs in $C/in; $C/py must be writable by uid 10001
docker run --rm --user 10001 --network none \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx:ro" -v "$C/in:/in:ro" -v "$C/py:/out" -w /src/worker \
  -e PYTHONPATH=/src/worker:/src/shared \
  ficino-worker python -I /fx/goldens/gen/pdf_text.py /in /out
(cd server && npx tsx scripts/compare-extraction.ts "$C/in" "$C/ts")
for f in "$C"/py/*.pymupdf.md; do n=$(basename "$f" .pymupdf.md); diff -q "$f" "$C/ts/$n.ts.md"; done
```

These scripts are deleted at the cutover together with `worker/`.

## Chunker and quality-check goldens

`chunker.py` runs `worker/lib/chunker.py` over `chunker-inputs.json` (`[{name, markdown, max_tokens}]`, built from
`sample.pymupdf.md` plus edge cases) and writes `chunker.json` (`[{name, chunks}]`). `quality.py` builds its own
texts, runs `worker/lib/quality_check.py` and writes `quality.json` (`[{text, ok, reason}]`). Both write to a file,
because structlog logs to stdout. A case on which Python raises (a special-token string) is skipped, not recorded.
tiktoken needs the `cl100k_base` file: the cache dir below already holds it; for a fresh cache drop `--network none` once.

```bash
run() { docker run --rm --user 10001 --network none \
  -e TIKTOKEN_CACHE_DIR=/cache -v <scratch>/tiktoken-cache:/cache \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker ficino-worker python -I "$@"; }
run /fx/goldens/gen/chunker.py /fx/goldens/chunker-inputs.json /fx/goldens/chunker.json
run /fx/goldens/gen/quality.py /fx/goldens/sample.pymupdf.md /fx/goldens/quality.json
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.
