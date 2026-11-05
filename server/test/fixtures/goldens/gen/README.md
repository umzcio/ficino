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
SCRATCH=...   # any directory outside the repo
C=$SCRATCH/extract-compare   # PDFs in $C/in; $C/py must be writable by uid 10001
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
SCRATCH=...   # any directory outside the repo
run() { docker run --rm --user 10001 --network none \
  -e TIKTOKEN_CACHE_DIR=/cache -v $SCRATCH/tiktoken-cache:/cache \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker ficino-worker python -I "$@"; }
run /fx/goldens/gen/chunker.py /fx/goldens/chunker-inputs.json /fx/goldens/chunker.json
run /fx/goldens/gen/quality.py /fx/goldens/sample.pymupdf.md /fx/goldens/quality.json
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.

## Feed goldens

`feed_pure.py` imports `worker/lib/persona.py` (with `get_personas` patched, so no database) and writes
`feed-pure.json` (`short_cite`, `sources`, `category`, `blend`, `enabled` cases with the Python result as `expected`)
and `system-preamble.txt` (`SYSTEM_PREAMBLE`, byte for byte). `test/feed/personas.test.ts` pins `src/feed/personas.ts` to them.

```bash
docker run --rm --user 10001 --network none \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker \
  -e PYTHONPATH=/src/worker:/src/shared \
  ficino-worker python -I /fx/goldens/gen/feed_pure.py /fx/goldens
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.

`persona_prompts.py` patches `get_personas`, `_fetch_chunks_by_ids` and `random.choice`/`randint` (first item, low
bound), runs `build_post_prompt` over fixed cases and writes `persona-prompts.json` (`[{name, args, prompt}]`).
`test/feed/prompts.test.ts` replays `args` with `rng = () => 0` and compares against `prompt`.

```bash
docker run --rm --user 10001 --network none \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker \
  -e PYTHONPATH=/src/worker:/src/shared \
  ficino-worker python -I /fx/goldens/gen/persona_prompts.py /fx/goldens
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.

`post_parse.py` runs `_parse_post_json` and `validate_post_shape` over fixed inputs and writes `post-parse.json`
(`[{fn, input, output | raises}]`). `test/feed/llmPost.test.ts` pins `src/feed/llmPost.ts` to it. No case uses NaN/Infinity,
which Python's `json.loads` accepts and `JSON.parse` rejects.

```bash
docker run --rm --user 10001 --network none \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker \
  -e PYTHONPATH=/src/worker:/src/shared \
  ficino-worker python -I /fx/goldens/gen/post_parse.py /fx/goldens
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.

## Conversation goldens

`conversation_prompts.py` runs in the `ficino-api` image. It imports `routers.personas` and `routers.replies` and calls
the real `send_persona_dm`, `create_reply` and `zap_response` coroutines (`_rl=None`) against a `FakeDb` that answers
by SQL substring from each case's canned rows. It patches `generate_response` in both modules and
`_llm_call_with_fresh_conn` to record `{system, messages, max_tokens, temperature}` and return `R<n>`,
`_load_conversation_and_sources` and `_load_reply_context_chunks` to return the case's thread, sources and chunks, and
`random.random` to return the case's value (counting calls). It writes `conversation-prompts.json`
(`[{name, kind, input, calls, rng_calls, response}]`, `response` without `id`). `test/conversations/prompts.test.ts`
pins `src/conversations/prompts.ts` to it.

```bash
docker run --rm --user 10001 --network none \
  -v "$PWD/api:/src/api:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/api \
  -e PYTHONPATH=/src/api:/src/shared \
  ficino-api python -I /fx/goldens/gen/conversation_prompts.py /fx/goldens
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.

## Summary and synthesis goldens

`summary_tasks.py` runs in the `ficino-worker` image. It imports `tasks.summary_tasks` and calls the real
`generate_paper_summary.run(paper_id)` and `generate_corpus_synthesis.run(...)` per case, with `fetchrow`, `fetch` and
`execute` answered from the case's canned rows (every `execute` recorded), `apply_provider_settings` a no-op,
`claude_client.generate_text_sync` recording `(system, prompt, kwargs)` and returning the case's raw text, each task's
`update_state` a no-op and its `retry` returning `exc` (so `raise self.retry(exc=exc)` re-raises without a broker). It
writes `summary-tasks.json` (`[{name, task, rows, raw, call, stored_messages, result}]`, plus `args` for synthesis;
`stored_messages` is `json.loads` of the upsert's messages argument, `result` is `{raises}` when the task raised).
`test/conversations/summaryParse.test.ts` pins `src/conversations/summaryParse.ts` to it.

```bash
docker run --rm --user 10001 --network none \
  -v "$PWD/worker:/src/worker:ro" -v "$PWD/shared:/src/shared:ro" \
  -v "$PWD/server/test/fixtures:/fx" -w /src/worker \
  -e PYTHONPATH=/src/worker:/src/shared \
  ficino-worker python -I /fx/goldens/gen/summary_tasks.py /fx/goldens
```

As above, `chmod 777` the goldens dir first and restore the mode and ownership (root, 755) afterwards.
