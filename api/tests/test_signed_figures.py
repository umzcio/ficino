"""End-to-end verification of the signed figure download route.

Covers:
  * valid signed URL returns the image bytes (200)
  * tampered token is rejected (403)
  * expired token is rejected (403)
  * missing token is rejected (422, validator)
  * token for figure A cannot be used for figure B (403 — signature mismatch)
  * user B cannot download user A's figure even with a valid token (404 — ownership)
"""
from __future__ import annotations

import os
import uuid

import asyncpg
import pytest
import pytest_asyncio

from config import settings
from signed_url import sign_resource


@pytest_asyncio.fixture
async def seeded_figure(db_conn: asyncpg.Connection, seeded_users):
    """Insert a real figure file on disk + DB row owned by user A."""
    figure_id = str(uuid.uuid4())
    # Minimal 1x1 PNG (67 bytes) — enough for FileResponse to serve.
    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082"
    )
    os.makedirs(settings.figures_dir, exist_ok=True)
    filename = f"{figure_id}.png"
    disk_path = os.path.join(settings.figures_dir, filename)
    with open(disk_path, "wb") as f:
        f.write(png_bytes)

    await db_conn.execute(
        """INSERT INTO figures (id, paper_id, page_number, image_path,
                                extraction_type, description, claim_summary,
                                figure_index)
           VALUES ($1, $2, 1, $3, 'image', 'desc', 'claim', 0)""",
        figure_id, seeded_users["paper_a"], disk_path,
    )

    yield {"figure_id": figure_id, "paper_id": seeded_users["paper_a"]}

    await db_conn.execute("DELETE FROM figures WHERE id = $1", figure_id)
    if os.path.exists(disk_path):
        os.remove(disk_path)


@pytest.mark.asyncio
async def test_signed_url_happy_path(client_as_user_a, seeded_figure):
    fid = seeded_figure["figure_id"]
    pid = seeded_figure["paper_id"]
    token = sign_resource(fid)
    r = await client_as_user_a.get(f"/figures/{pid}/{fid}?token={token}")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/")
    # PNG magic bytes
    assert r.content.startswith(b"\x89PNG")


@pytest.mark.asyncio
async def test_missing_token_rejected(client_as_user_a, seeded_figure):
    fid = seeded_figure["figure_id"]
    pid = seeded_figure["paper_id"]
    r = await client_as_user_a.get(f"/figures/{pid}/{fid}")
    # FastAPI Query(..., min_length=10) → 422 on missing/invalid token
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_tampered_token_rejected(client_as_user_a, seeded_figure):
    fid = seeded_figure["figure_id"]
    pid = seeded_figure["paper_id"]
    token = sign_resource(fid)
    # Flip the last two chars of the digest
    bad = token[:-2] + ("AA" if not token.endswith("AA") else "BB")
    r = await client_as_user_a.get(f"/figures/{pid}/{fid}?token={bad}")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_expired_token_rejected(client_as_user_a, seeded_figure):
    fid = seeded_figure["figure_id"]
    pid = seeded_figure["paper_id"]
    token = sign_resource(fid, ttl=-60)
    r = await client_as_user_a.get(f"/figures/{pid}/{fid}?token={token}")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_token_bound_to_figure_id(client_as_user_a, seeded_figure):
    """A valid token for figure A must not authorize figure B."""
    fid = seeded_figure["figure_id"]
    pid = seeded_figure["paper_id"]
    other_token = sign_resource(str(uuid.uuid4()))  # signed for a different id
    r = await client_as_user_a.get(f"/figures/{pid}/{fid}?token={other_token}")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_cross_user_rejected_even_with_valid_token(
    client_as_user_b, seeded_figure
):
    """User B cannot download user A's figure even if they somehow hold a valid token."""
    fid = seeded_figure["figure_id"]
    pid = seeded_figure["paper_id"]
    token = sign_resource(fid)
    r = await client_as_user_b.get(f"/figures/{pid}/{fid}?token={token}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_figures_list_includes_signed_token(client_as_user_a, seeded_figure):
    """GET /papers/{id}/figures must return image_url with ?token=… parameter."""
    pid = seeded_figure["paper_id"]
    r = await client_as_user_a.get(f"/papers/{pid}/figures")
    assert r.status_code == 200
    body = r.json()
    assert len(body) >= 1
    entry = next(f for f in body if f["id"] == seeded_figure["figure_id"])
    assert "token=" in entry["image_url"]
    # And the signed URL actually works when followed
    r2 = await client_as_user_a.get(entry["image_url"])
    assert r2.status_code == 200
