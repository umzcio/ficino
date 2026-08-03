# Plan 032: Document the figure-detection model env vars in .env.example

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- .env.example worker/lib/figure_detector.py`
> If either file changed since this plan was written, compare against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

`worker/lib/figure_detector.py` reads two model-override env vars that `.env.example` doesn't mention — operators who want to change the figure-detection model must read source to learn the knobs exist. A full diff of code-read env vars against `.env.example` (done during the audit) found these are the ONLY two genuinely missing; this keeps the example file complete.

## Current state

- `worker/lib/figure_detector.py:21-23` documents the knobs in its module docstring:

```
    FIGURE_DETECT_PROVIDER = anthropic | ollama | none
    FIGURE_DETECT_ANTHROPIC_MODEL = claude-sonnet-4-6 (default)
    FIGURE_DETECT_OLLAMA_MODEL  = qwen2.5vl:latest or similar
```

and line 61 reads `FIGURE_DETECT_OLLAMA_MODEL` (default `qwen2.5vl:latest`); the anthropic model var is read nearby (confirm the exact default at `figure_detector.py:55-65` before writing).
- `.env.example:131-132` currently documents only the provider:

```
# Scientific-figure detection provider ("anthropic" | "ollama" | "none").
# FIGURE_DETECT_PROVIDER=anthropic
```

- Style convention of `.env.example`: commented-out assignments with a one-line description above, grouped by feature.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Content check | `grep -n "FIGURE_DETECT" .env.example` | all three vars present |

## Scope

**In scope**:
- `.env.example`

**Out of scope**:
- `worker/lib/figure_detector.py` — the docstring is already accurate.
- Any other env var (the audit verified the file is otherwise complete).

## Git workflow

- Branch: `advisor/032-figure-detect-env-docs` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): `docs: document figure-detection model env vars in .env.example`.

## Steps

### Step 1: Add the two entries

Edit `.env.example` directly after the `# FIGURE_DETECT_PROVIDER=anthropic` line, matching the file's comment style and using the ACTUAL defaults from `figure_detector.py` (verify at lines 55-65):

```
# Model overrides for figure detection (defaults shown).
# FIGURE_DETECT_ANTHROPIC_MODEL=claude-sonnet-4-6
# FIGURE_DETECT_OLLAMA_MODEL=qwen2.5vl:latest
```

**Verify**: `grep -n "FIGURE_DETECT" .env.example` → provider + both model vars, each commented.

## Test plan

- Docs-only; the grep above is the check. The values must match the code defaults (that comparison is the real test).

## Done criteria

- [ ] Both vars present in `.env.example` with defaults matching `worker/lib/figure_detector.py`
- [ ] Only `.env.example` modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

- The defaults in code differ from what this plan quotes — use the code's values and note the discrepancy in your report.
- `.env.example` was restructured (drift) — place the entries wherever `FIGURE_DETECT_PROVIDER` lives now.

## Maintenance notes

- When a future env var is added to the worker, the check is `grep -roh "[A-Z_]\{4,\}" worker/lib/*.py` (roughly) vs `.env.example` — or just remember this file exists. AGENTS.md (plan 031) points here.
