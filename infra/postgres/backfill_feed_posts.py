"""Backfill the feed_posts search index from feeds.posts JSONB.

Idempotent: uses ON CONFLICT (feed_id, post_index) DO UPDATE so re-runs are
safe. Meant to be run ONCE after `add_feed_posts_table.sql` lands, and again
any time the secondary index drifts from the JSONB source of truth.

Run from the api container (has DATABASE_URL via env_file):

    docker exec ficino-api python /app/infra/backfill_feed_posts.py

Or directly:

    DATABASE_URL=postgresql://ficino:ficino@postgres:5432/ficino python backfill_feed_posts.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import asyncpg

from ficino_shared.constants import DEFAULT_DATABASE_URL


DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)


async def backfill() -> None:
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        feeds = await conn.fetch("SELECT id, user_id, posts FROM feeds ORDER BY generated_at")
        print(f"Found {len(feeds)} feeds to backfill")

        total_inserted = 0
        total_skipped_feeds = 0

        for feed in feeds:
            feed_id = feed["id"]
            user_id = feed["user_id"]
            posts = feed["posts"]
            if isinstance(posts, str):
                posts = json.loads(posts)
            if not posts:
                total_skipped_feeds += 1
                continue

            for post_index, p in enumerate(posts):
                if not isinstance(p, dict):
                    continue
                content_text = str(p.get("content", ""))[:10000]
                await conn.execute(
                    """INSERT INTO feed_posts
                       (feed_id, user_id, post_index, content_text, persona, post_type,
                        category, paper_ref, data, deleted)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
                       ON CONFLICT (feed_id, post_index) DO UPDATE SET
                         content_text = EXCLUDED.content_text,
                         persona = EXCLUDED.persona,
                         post_type = EXCLUDED.post_type,
                         category = EXCLUDED.category,
                         paper_ref = EXCLUDED.paper_ref,
                         data = EXCLUDED.data,
                         deleted = EXCLUDED.deleted""",
                    feed_id,
                    user_id,
                    post_index,
                    content_text,
                    p.get("persona"),
                    p.get("post_type"),
                    p.get("category"),
                    p.get("paper_ref"),
                    json.dumps(p, default=str),
                    bool(p.get("deleted", False)),
                )
                total_inserted += 1

        print(f"Backfilled {total_inserted} rows across {len(feeds) - total_skipped_feeds} feeds "
              f"({total_skipped_feeds} empty feeds skipped)")

        # Parity check
        total_rows = await conn.fetchval("SELECT COUNT(*) FROM feed_posts")
        jsonb_total = await conn.fetchval(
            "SELECT COALESCE(SUM(jsonb_array_length(posts)), 0) FROM feeds"
        )
        print(f"feed_posts rows: {total_rows}")
        print(f"feeds.posts total elements: {jsonb_total}")
        if total_rows != jsonb_total:
            print(
                f"WARN: row count ({total_rows}) != JSONB total ({jsonb_total}) — "
                "probably non-dict entries in some feeds.posts arrays; re-run to repair."
            )
            sys.exit(1)
        else:
            print("Parity check: OK")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(backfill())
