"""Alert generation tasks — surface learning insight moments.

Runs post-ingestion and post-feed-generation to detect:
- Contradictions between new paper and existing corpus
- Emerging themes across papers
- Persona disagreement spikes
- Reading gaps and stale papers
"""

import hashlib
import json

import structlog
from celery import Task

from celery_app import app
from lib import claude_client
from lib.db import execute, fetch, fetchrow
from lib.settings import apply_provider_settings, STUB_USER_ID

logger = structlog.get_logger(__name__)


def _dedupe_hash(*parts: str) -> str:
    """Stable short hash for alert idempotency keys.

    Sort parts first so `(paper_a, paper_b)` dedupes the same as
    `(paper_b, paper_a)` — a contradiction is symmetric.
    """
    payload = "|".join(sorted(parts))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _create_alert(
    alert_type: str,
    title: str,
    body: str,
    metadata: dict | None = None,
    user_id: str | None = None,
    dedupe_hash: str | None = None,
) -> None:
    """Insert an alert into the database.

    When `dedupe_hash` is provided, INSERT ON CONFLICT DO NOTHING against
    the partial UNIQUE index `alerts_dedupe_idx (user_id, alert_type,
    dedupe_hash)` so a retry of check_contradictions /
    check_post_feed / check_stale_papers doesn't pile up identical rows
    in the user's bell. Writers that genuinely want every occurrence
    leave dedupe_hash=None and keep the prior insert-always behaviour.
    """
    uid = user_id or STUB_USER_ID
    execute(
        """INSERT INTO alerts (user_id, alert_type, title, body, metadata, dedupe_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, alert_type, dedupe_hash)
             WHERE dedupe_hash IS NOT NULL
             DO NOTHING""",
        uid,
        alert_type,
        title,
        body,
        json.dumps(metadata or {}),
        dedupe_hash,
    )
    logger.info("alert_created", type=alert_type, title=title, dedup=dedupe_hash is not None)


@app.task(
    bind=True,
    max_retries=1,
    name="tasks.alert_tasks.check_contradictions",
)
def check_contradictions(self: Task, paper_id: str) -> dict[str, object]:
    """Check if a newly ingested paper contradicts existing corpus papers.

    Retrieves chunks from the new paper, compares against all other papers.
    """
    log = logger.bind(paper_id=paper_id, task_id=self.request.id)
    log.info("contradiction_check_start")

    try:
        # Fetch the owning user_id too so every alert we create below is
        # scoped to the paper owner rather than the STUB_USER_ID fallback
        # inside _create_alert — under SaaS that fallback would orphan the
        # contradiction signal to a user nobody can read.
        paper = fetchrow(
            "SELECT id, title, filename, corpus_id, user_id FROM papers WHERE id = $1",
            paper_id,
        )
        if not paper:
            return {"status": "skipped", "reason": "paper_not_found"}

        paper_title = paper["title"] or paper["filename"]
        paper_user_id = str(paper["user_id"]) if paper["user_id"] else STUB_USER_ID

        # Scope provider settings to the paper owner so the ~24 classify
        # calls below run under their LLM key / model config, not whoever
        # happened to leave settings cached in this prefork child.
        apply_provider_settings(paper_user_id)

        # Get other complete papers in the same workspace. Bounded to 8 so a
        # large corpus doesn't fan out to 3×N LLM calls per upload (200-paper
        # workspace → 600 Claude calls without the cap). ORDER BY random()
        # so we spread the comparison surface across the library over time.
        other_papers = fetch(
            """SELECT id, title, filename FROM papers
               WHERE corpus_id = $1 AND id != $2 AND status = 'complete'
               ORDER BY random() LIMIT 8""",
            paper["corpus_id"], paper_id,
        )

        if not other_papers:
            log.info("no_other_papers_to_compare")
            return {"status": "skipped", "reason": "no_other_papers"}

        # Get key chunks from the new paper
        new_chunks = fetch(
            """SELECT content, section FROM chunks
               WHERE paper_id = $1 AND section NOT IN ('references', 'bibliography', 'acknowledgments', 'funding')
               ORDER BY chunk_index LIMIT 8""",
            paper_id,
        )

        if not new_chunks:
            return {"status": "skipped", "reason": "no_chunks"}

        # Batch-fetch chunks for every other paper in one SQL instead of
        # one fetch per iteration (was 8 sequential RTT). Group in Python.
        other_ids = [str(o["id"]) for o in other_papers]
        other_chunk_rows = fetch(
            """SELECT paper_id, content, section FROM chunks
               WHERE paper_id = ANY($1)
                 AND section NOT IN ('references', 'bibliography', 'acknowledgments', 'funding')
               ORDER BY paper_id, chunk_index""",
            other_ids,
        )
        chunks_by_paper: dict[str, list[dict]] = {}
        for row in other_chunk_rows:
            chunks_by_paper.setdefault(str(row["paper_id"]), []).append(
                {"content": row["content"], "section": row["section"]}
            )

        # Build every sample pair up front so we can classify them all
        # concurrently. `pair_meta` keeps enough info to attribute a
        # contradiction hit back to its (other_paper, chunk_a, chunk_b).
        import random
        pairs: list[tuple[str, str]] = []
        pair_meta: list[tuple[str, str, str, str]] = []  # (other_id, other_title, chunk_a, chunk_b)
        for other in other_papers:
            other_id = str(other["id"])
            other_title = other["title"] or other["filename"]
            other_chunks = chunks_by_paper.get(other_id) or []
            # Cap each other paper's chunks LIMIT 8 to match the prior
            # behaviour (we fetched 8 per paper before the batching).
            other_chunks = other_chunks[:8]
            if not other_chunks:
                continue
            for _ in range(3):
                nc = random.choice(new_chunks)
                oc = random.choice(other_chunks)
                pairs.append((nc["content"], oc["content"]))
                pair_meta.append((other_id, other_title, nc["content"], oc["content"]))

        if not pairs:
            log.info("no_pairs_to_classify")
            return {"status": "complete", "contradictions": 0}

        # One bounded-concurrent batch instead of up to 24 serial Claude
        # calls. At concurrency=5 this drops worst-case ~17s serial to ~3s.
        results = claude_client.classify_contradictions_batch_sync(pairs, concurrency=5)

        contradictions_found = 0
        seen_other_ids: set[str] = set()
        for (other_id, other_title, chunk_a, chunk_b), verdict in zip(pair_meta, results):
            # One contradiction alert per paper pair is enough — preserves
            # the serial loop's early `break` semantics after a hit.
            if other_id in seen_other_ids:
                continue
            if verdict == "contradicts":
                contradictions_found += 1
                seen_other_ids.add(other_id)
                _create_alert(
                    alert_type="contradiction",
                    title="Contradiction detected",
                    body=f'"{paper_title}" challenges a finding in "{other_title}". The papers present conflicting evidence on overlapping topics.',
                    metadata={
                        "new_paper_id": paper_id,
                        "other_paper_id": other_id,
                        "new_paper_title": paper_title,
                        "other_paper_title": other_title,
                        "chunk_a_preview": chunk_a[:200],
                        "chunk_b_preview": chunk_b[:200],
                    },
                    user_id=paper_user_id,
                    dedupe_hash=_dedupe_hash("contradiction", paper_id, other_id),
                )

        log.info("contradiction_check_complete", contradictions=contradictions_found)
        return {"status": "complete", "contradictions": contradictions_found}

    except Exception as exc:
        log.error("contradiction_check_failed", error=str(exc))
        raise


@app.task(
    bind=True,
    max_retries=1,
    name="tasks.alert_tasks.check_post_feed",
)
def check_post_feed(self: Task, feed_id: str) -> dict[str, object]:
    """Check for persona disagreement spikes after feed generation."""
    log = logger.bind(feed_id=feed_id, task_id=self.request.id)
    log.info("post_feed_check_start")

    try:
        feed = fetchrow("SELECT user_id, posts, post_count FROM feeds WHERE id = $1", feed_id)
        if not feed or not feed["posts"]:
            return {"status": "skipped"}

        owner_id = str(feed["user_id"])
        # check_post_feed itself runs no LLM calls today, but any future
        # addition (e.g. disagreement-summarization) would otherwise
        # inherit whatever user's settings leaked from the prior task.
        apply_provider_settings(owner_id)

        posts = feed["posts"]
        if isinstance(posts, str):
            posts = json.loads(posts)

        # Count debate posts (quotes + replies)
        debate_count = sum(1 for p in posts if p.get("post_type") in ("quote", "reply"))
        total = len(posts)

        if total > 0 and debate_count / total > 0.5:
            _create_alert(
                alert_type="disagreement_spike",
                title="High-debate feed generated",
                body=f"Your latest feed has {debate_count} debate posts out of {total} — the personas are really arguing. Something in your corpus is provocative.",
                metadata={"feed_id": feed_id, "debate_count": debate_count, "total": total},
                user_id=owner_id,
                dedupe_hash=_dedupe_hash("disagreement_spike", feed_id),
            )

        # Check for reading gaps — papers debated but never summarized.
        # Scope by the feed owner so a multi-tenant deployment doesn't leak
        # one user's paper titles into another user's alert feed.
        paper_refs = set()
        for p in posts:
            ref = p.get("paper_ref")
            if ref:
                paper_refs.add(ref)

        if paper_refs:
            unsummarized = fetch(
                """SELECT p.id, p.title, p.filename FROM papers p
                   LEFT JOIN paper_summaries ps ON p.id = ps.paper_id
                   WHERE ps.id IS NULL AND p.status = 'complete' AND p.user_id = $1""",
                owner_id,
            )
            for paper in unsummarized:
                title = paper["title"] or paper["filename"]
                # Check if this paper was referenced in the feed
                if any(title in ref for ref in paper_refs):
                    _create_alert(
                        alert_type="reading_gap",
                        title="Go deeper on this paper",
                        body=f'Personas are debating "{title}" in your feeds, but you haven\'t read its summary yet. Tap to explore.',
                        metadata={"paper_id": str(paper["id"]), "paper_title": title},
                        user_id=owner_id,
                        dedupe_hash=_dedupe_hash("reading_gap", str(paper["id"])),
                    )

        log.info("post_feed_check_complete")
        return {"status": "complete"}

    except Exception as exc:
        log.error("post_feed_check_failed", error=str(exc))
        raise


@app.task(
    bind=True,
    max_retries=1,
    name="tasks.alert_tasks.check_stale_papers",
)
def check_stale_papers(self: Task) -> dict[str, object]:
    """Check for papers that have never appeared in a feed.

    Scans across all users — each stale paper gets an alert addressed to
    that paper's owner (not the scheduler's user_id, which would collapse
    every tenant's alerts onto a single inbox).
    """
    log = logger.bind(task_id=self.request.id)

    try:
        stale = fetch(
            """SELECT p.id, p.user_id, p.title, p.filename, p.uploaded_at
               FROM papers p
               WHERE p.status = 'complete'
               AND p.uploaded_at < NOW() - INTERVAL '7 days'
               AND NOT EXISTS (
                   SELECT 1 FROM feeds f WHERE f.corpus_id = p.corpus_id
               )"""
        )

        for paper in stale:
            title = paper["title"] or paper["filename"]
            _create_alert(
                alert_type="stale_paper",
                title="Unused paper in your corpus",
                body=f'"{title}" has been in your corpus for over a week but hasn\'t been part of any feed generation. Consider generating a feed or removing it.',
                metadata={"paper_id": str(paper["id"]), "paper_title": title},
                user_id=str(paper["user_id"]),
                dedupe_hash=_dedupe_hash("stale_paper", str(paper["id"])),
            )

        log.info("stale_check_complete", stale_count=len(stale))
        return {"status": "complete", "stale_count": len(stale)}

    except Exception as exc:
        log.error("stale_check_failed", error=str(exc))
        raise
