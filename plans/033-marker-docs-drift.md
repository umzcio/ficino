# Plan 033: Correct the Marker extraction docs drift

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- FEATURES.md worker/lib/marker_extractor.py worker/tasks/ingestion_tasks.py`
> If any in-scope file changed since this plan was written, compare against
> the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

`FEATURES.md` and `marker_extractor.py`'s own docstring present Marker as the primary extraction path — but `marker-pdf` is installed NOWHERE (not in `worker/requirements.txt`, not in the Dockerfile), so `_MARKER_AVAILABLE` is False in every shipped image and ingestion always falls through to PyMuPDF. Docs describing a pipeline stage that never executes cause operators to mis-predict behavior and debug phantom "Marker quality" issues.

## Current state

- `FEATURES.md:28` — shipped ingestion described as "text extraction (Marker/PyMuPDF/vision fallback)".
- `worker/lib/marker_extractor.py:1` — docstring opens: "Marker-based PDF text extraction — primary extraction path." (The docstring DOES note the PyMuPDF fallback at lines 5-6; the "primary" framing is what's wrong.)
- `worker/requirements.txt` — no `marker-pdf` (grep confirms). The file documents the same optional-heavy-dep pattern for the local reranker ("Kept out of the base install... Self-hosters who want local reranking should...") — Marker should be documented in the same spirit.
- `worker/tasks/ingestion_tasks.py:135` — the extraction-mode branch that always falls through when marker is unavailable. Read it to get the real precedence order right for the doc wording.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint (docstring touched) | `ruff check worker/lib/marker_extractor.py` | exit 0 |
| Content check | `grep -n -i "marker" FEATURES.md worker/lib/marker_extractor.py` | no "primary" framing remains |

## Scope

**In scope**:
- `FEATURES.md` (line 28 wording)
- `worker/lib/marker_extractor.py` (docstring only — no code)

**Out of scope**:
- `worker/requirements.txt` — do NOT add marker-pdf (a ~2GB optional dep; making it installable is a product decision, not docs cleanup). One comment line referencing the option is acceptable IF the reranker-style pattern already exists there to mirror — otherwise leave the file untouched.
- `worker/tasks/ingestion_tasks.py` — read for accuracy, don't edit.

## Git workflow

- Branch: `advisor/033-marker-docs-drift` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `docs: correct marker extraction framing (optional, not installed by default)`.

## Steps

### Step 1: FEATURES.md

Change line 28's "text extraction (Marker/PyMuPDF/vision fallback)" to reflect reality: PyMuPDF primary, optional Marker if the operator installs `marker-pdf` themselves, vision fallback for quality-check failures. Keep the table cell one line.

### Step 2: marker_extractor.py docstring

Reword the first line: "primary extraction path" → "optional high-quality extraction path (not installed by default — `pip install marker-pdf` to enable; PyMuPDF is the default)". Keep the rest of the docstring (it accurately describes the fallback).

**Verify**: `ruff check worker/lib/marker_extractor.py` → exit 0; the content grep above → clean.

## Test plan

- Docs-only; the greps are the check. Accuracy gate: the wording must match the actual fall-through order in `ingestion_tasks.py:135` (read it).

## Done criteria

- [ ] No "primary extraction path" framing for Marker remains
- [ ] Wording matches the real code path order
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

- `marker-pdf` turns out to be installed somewhere after all (requirements-dev, a Dockerfile, shared/) — report where; the finding may be inverted (docs right, install wrong).
- The ingestion branch has drifted (e.g. marker removed entirely — then the finding is dead code, report that instead).

## Maintenance notes

- If marker-pdf is ever added as an optional extra (mirroring the reranker's documented pattern), update both spots again in the same PR.
