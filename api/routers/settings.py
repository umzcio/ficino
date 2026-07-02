"""User settings endpoints."""

import asyncio
import json

import asyncpg
import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException

from config import settings as app_settings
from auth import AuthUser, get_current_user
from db.connection import get_db
from models.requests import SettingsUpdate
from storage import storage
from ficino_shared.settings_schema import (
    DEFAULTS,
    NUMERIC_BOUNDS as _NUMERIC_BOUNDS,
    PROVIDER_OVERRIDE_KEYS,
    SECRET_KEYS,
    is_public_deployment,
    merge_settings,
    reassert_public_deployment,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/settings", tags=["settings"])


def _cleanup_artifacts(user_id: str, paper_ids: list[str], log_event: str) -> int:
    """Delete on-disk/cloud artifacts (PDFs + figure crops) for a batch of
    papers. Runs in a worker thread via asyncio.to_thread — synchronous
    storage-adapter calls would otherwise block the event loop.

    Shared by clear_everything and clear_all_papers (R10 API-14): both
    previously defined byte-identical inner closures differing only in the
    log event name, which this hoists to a parameter. Failures are logged
    and skipped rather than raised — the DB row is the source of truth for
    what the user "has", and orphaned artifacts get reaped by routine
    maintenance.
    """
    freed = 0
    for pid in paper_ids:
        try:
            storage.delete_paper_artifacts(user_id, pid)
            freed += 1
        except Exception as e:
            logger.warn(log_event, paper_id=pid, error=str(e)[:120])
    return freed



# Allow-list of settings keys accepted from user input. Anything not here
# is dropped silently with a warn log. This closes a user-controlled SSRF
# where `ollama_base_url` (and similar URL-shaped keys) in the settings
# blob could redirect every downstream LLM call to an attacker-chosen host.
ALLOWED_SETTINGS_KEYS = frozenset(DEFAULTS.keys())


def _redact_secrets(d: dict[str, object]) -> dict[str, object]:
    """Replace secret keys in a settings dict with 'set' / ''."""
    return {k: ("set" if v else "") if k in SECRET_KEYS else v for k, v in d.items()}


@router.get("")
async def get_settings(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get current settings, merged with defaults."""
    row = await db.fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        user.id,
    )

    user_settings = {}
    if row:
        user_settings = row["settings"]
        if isinstance(user_settings, str):
            user_settings = json.loads(user_settings)

    # Merge: defaults ← user overrides, then (under PUBLIC_DEPLOYMENT) reassert
    # the operator's env config so a stale self-host row can't mask the
    # provider the worker will actually use (R10 DUP-1 last gap).
    merged = merge_settings(user_settings)
    if is_public_deployment():
        merged = reassert_public_deployment(merged)

    return _redact_secrets(merged)


@router.put("")
async def update_settings(
    body: SettingsUpdate,
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Update settings. Partial updates supported — only send changed keys."""
    # Drop anything not on the whitelist before merging; reject out-of-range
    # numeric knobs so a client can't turn `posts_per_generation` into a
    # 10,000-shot LLM loop.
    filtered: dict[str, object] = {}
    dropped: list[str] = []
    locked: list[str] = []
    for key, value in body.settings.items():
        if key not in ALLOWED_SETTINGS_KEYS:
            dropped.append(key)
            continue
        # On hosted deployments the operator's env config is the single
        # source of truth for providers + keys. Any user attempt to override
        # is dropped silently with a warn log (not 422 — the hosted UI
        # shouldn't be sending these anyway, and 422 leaks config state).
        if app_settings.public_deployment and key in PROVIDER_OVERRIDE_KEYS:
            locked.append(key)
            continue
        if key in _NUMERIC_BOUNDS:
            expected_type, lo, hi = _NUMERIC_BOUNDS[key]
            try:
                coerced = expected_type(value)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=422,
                    detail=f"{key} must be a {expected_type.__name__}",
                )
            if coerced < lo or coerced > hi:
                raise HTTPException(
                    status_code=422,
                    detail=f"{key} must be between {lo} and {hi}",
                )
            filtered[key] = coerced
        else:
            filtered[key] = value
    if dropped:
        logger.warn("settings_dropped_unknown_keys", keys=dropped, user_id=user.id)
    if locked:
        logger.warn(
            "settings_dropped_provider_override_on_public_deployment",
            keys=locked, user_id=user.id,
        )

    # Read-merge-write inside a transaction with SELECT ... FOR UPDATE so a
    # concurrent worker preference recompute (which takes the same row lock
    # via ON CONFLICT DO UPDATE) can't clobber our write — and vice versa.
    # The worker writes only the `preferences` sub-key via jsonb_set, so our
    # top-level merge here preserves it even if we don't explicitly re-read.
    # The lock still matters for two concurrent PUTs from the same user
    # (multi-tab / double-submit) which would otherwise lose turns.
    async with db.transaction():
        row = await db.fetchrow(
            "SELECT settings FROM user_settings WHERE user_id = $1 FOR UPDATE",
            user.id,
        )

        existing = {}
        if row:
            existing = row["settings"]
            if isinstance(existing, str):
                existing = json.loads(existing)

        # Merge updates. Dict values get a shallow merge to preserve any
        # sub-keys the UI didn't resend (e.g. toggling one persona shouldn't
        # wipe the rest of personas_enabled).
        for key, value in filtered.items():
            if key in existing and isinstance(existing[key], dict) and isinstance(value, dict):
                existing[key] = {**existing[key], **value}
            else:
                existing[key] = value

        settings_json = json.dumps(existing)

        await db.execute(
            """INSERT INTO user_settings (user_id, settings, updated_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()""",
            user.id, settings_json,
        )

    logger.info("settings_updated", keys=list(filtered.keys()))

    # Return merged with defaults (secrets redacted — match GET shape). This
    # reassert is presentation only, mirroring GET: `existing` was already
    # persisted above (line ~150) with the raw `filtered` user keys, so
    # reasserting here does not touch what's stored in the DB.
    merged = merge_settings(existing)
    if is_public_deployment():
        merged = reassert_public_deployment(merged)
    return _redact_secrets(merged)


@router.get("/ollama-models")
async def list_ollama_models(
    user: AuthUser = Depends(get_current_user),
) -> dict[str, list[dict[str, str]]]:
    """List available Ollama models grouped by type.

    Auth-gated (R10 API-6/BP-13): was previously reachable by anyone,
    letting an unauthenticated caller trigger a 10s outbound HTTP call to
    the operator's Ollama instance and read back the installed model list.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{app_settings.ollama_base_url}/api/tags")
            resp.raise_for_status()
            models = resp.json().get("models", [])
    except Exception as e:
        logger.warn("ollama_models_fetch_failed", error=str(e))
        return {"llm": [], "embed": [], "vision": []}

    llm_models = []
    embed_models = []
    vision_models = []

    for m in models:
        name = m["name"]
        size_gb = round(m.get("size", 0) / 1e9, 1)
        info = {"name": name, "size": f"{size_gb}GB", "family": m.get("details", {}).get("family", "")}
        name_lower = name.lower()

        if "embed" in name_lower or "bge" in name_lower or "nomic" in name_lower:
            embed_models.append(info)
        else:
            llm_models.append(info)
            # Models with vision capabilities
            details = m.get("details", {})
            families = details.get("families", [])
            if any("vision" in f.lower() for f in families) or "vision" in name_lower:
                vision_models.append(info)

    return {"llm": llm_models, "embed": embed_models, "vision": vision_models}


@router.post("/clear-feeds", status_code=200)
async def clear_all_feeds(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Clear all generated feeds."""
    await db.execute("DELETE FROM feeds WHERE user_id = $1", user.id)
    return {"status": "cleared"}


@router.post("/clear-summaries", status_code=200)
async def clear_all_summaries(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Clear all paper summaries (forces regeneration)."""
    await db.execute(
        "DELETE FROM paper_summaries WHERE paper_id IN (SELECT id FROM papers WHERE user_id = $1)",
        user.id,
    )
    return {"status": "cleared"}


@router.post("/clear-user-posts", status_code=200)
async def clear_all_user_posts(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Clear all user posts and the Archivist replies attached to them."""
    await db.execute("DELETE FROM user_posts WHERE user_id = $1", user.id)
    return {"status": "cleared"}


@router.post("/clear-everything", status_code=200)
async def clear_everything(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Nuclear reset — delete every piece of user-generated content.

    Clearing only papers, only feeds, or only conversations leaves stale
    state behind: alerts/notifications in particular never get cleaned by
    the granular clears, and a user who wants a genuinely empty state had
    to click four buttons in sequence. This endpoint deletes the full set
    in a single transaction.

    Kept tables (intentional): corpora/workspaces, user_settings, personas.
    Those are account scaffolding, not content — the user keeps their
    workspaces and preferences, they just come back empty.

    Cascade coverage:
      feeds ─→ bookmarks, annotations, user_likes, post_replies
      papers ─→ chunks, figures, paper_summaries, paper_tags
      reading_lists ─→ reading_list_chapters
    alerts / persona_dms / user_posts / corpus_syntheses / tags are
    direct user_id cascades, deleted explicitly.
    """
    paper_rows = await db.fetch(
        "SELECT id FROM papers WHERE user_id = $1", user.id,
    )
    paper_ids = [str(r["id"]) for r in paper_rows]

    async with db.transaction():
        # Order matters only for legibility — each delete is scoped by
        # user_id or by a feed/paper/list that is itself user-scoped, so
        # there are no cross-user ownership leaks even mid-transaction.
        await db.execute("DELETE FROM alerts           WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM persona_dms      WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM user_posts       WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM corpus_syntheses WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM reading_lists    WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM feeds            WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM papers           WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM tags             WHERE user_id = $1", user.id)

    # Storage cleanup goes through the adapter so the same code works for
    # filesystem + cloud backends. delete_paper_artifacts is idempotent; we
    # log and keep going on failures.
    freed = await asyncio.to_thread(
        _cleanup_artifacts, user.id, paper_ids, "clear_everything_artifact_unlink_failed",
    )
    logger.info("clear_everything_complete",
                user_id=str(user.id),
                paper_count=len(paper_ids),
                artifacts_removed=freed)
    return {"status": "cleared", "paper_count": len(paper_ids)}


@router.post("/clear-papers", status_code=200)
async def clear_all_papers(
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Delete every paper for this user — chunks, figures, summaries, and
    feeds go with them.

    This is the most destructive user-facing action in the app. It was
    added because every other "clear all" in Danger Zone (feeds,
    summaries, conversations) had a sibling — papers were the only
    resource that still required manual per-item delete. For a research
    workflow where you want to start the whole corpus from scratch
    (e.g., after changing extraction settings or re-ingesting with a
    new pipeline) this is the only realistic reset button.

    Cascade coverage:
      - chunks.paper_id            ON DELETE CASCADE (init.sql)
      - figures.paper_id           ON DELETE CASCADE (init.sql)
      - paper_summaries.paper_id   ON DELETE CASCADE (init.sql)
      - paper_tags.paper_id        ON DELETE CASCADE (init.sql)
    Feeds don't cascade from papers (they reference corpora and hold
    paper_ids inside a JSONB posts array), so a feed that survives a
    bulk paper delete would render broken references — delete user's
    feeds explicitly too.

    Storage cleanup (PDF uploads + figure crops) is offloaded to a thread
    so a slow disk or cloud call doesn't block the event loop.

    The two DB deletes run inside one transaction (R10 API-14): this
    endpoint's own docstring above explains why feeds must go with papers
    — a feed that survives a bulk paper delete would render broken
    references — so a failure between the two DELETEs must not leave that
    exact half-deleted state on disk. clear_everything (below) already
    used this pattern; this endpoint was the one sibling that didn't.
    """
    # 1. Enumerate paper IDs so we can clean up artifacts after the DB rows
    #    are gone. Fetching before the delete is safe under transaction
    #    semantics — either both the SELECT and DELETE happen, or neither.
    paper_rows = await db.fetch(
        "SELECT id FROM papers WHERE user_id = $1", user.id,
    )
    paper_ids = [str(r["id"]) for r in paper_rows]

    # 2. DB cascade, transactional. Papers first (cascades
    #    chunks/figures/summaries/tags), then feeds (orphaned JSONB
    #    references) — either both deletes land or neither does.
    async with db.transaction():
        await db.execute("DELETE FROM papers WHERE user_id = $1", user.id)
        await db.execute("DELETE FROM feeds WHERE user_id = $1", user.id)

    # 3. Storage cleanup via the adapter — same code path for local disk
    #    and cloud buckets. Failures are logged but don't fail the API
    #    call; the DB row is the source of truth for what the user "has",
    #    and orphaned artifacts get reaped by routine maintenance.
    freed = await asyncio.to_thread(
        _cleanup_artifacts, user.id, paper_ids, "clear_papers_artifact_unlink_failed",
    )
    logger.info("clear_papers_complete",
                user_id=str(user.id),
                paper_count=len(paper_ids),
                files_removed=freed)
    return {"status": "cleared", "paper_count": len(paper_ids)}
