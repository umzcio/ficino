"""R10 API-19: `upload_paper` previously read the entire multipart body into
memory (`contents = await file.read()`) before enforcing the size cap. A
Content-Length pre-check now rejects an oversized upload with 413 before
that read runs — cheap request-amplification / memory-exhaustion mitigation.
Content-Length can be spoofed by a client, so the post-read `len(contents)`
check (400) stays in place as the authoritative guard; this test only
exercises the new early-exit path."""
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_spoofed_content_length_413s_before_read(client_as_user_a, seeded_users):
    """A Content-Length header declaring far more than the configured cap
    gets rejected with 413 — the small actual multipart body proves the
    handler never had to (and per the code, does not) read it in to hit
    this branch."""
    resp = await client_as_user_a.post(
        f"/papers?workspace_id={seeded_users['workspace_a']}",
        files={"file": ("test.pdf", b"%PDF-1.4 tiny", "application/pdf")},
        headers={"content-length": "999999999"},
    )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_small_upload_not_rejected_by_precheck(client_as_user_a, seeded_users):
    """A normal small upload with an honest (small) Content-Length is not
    caught by the pre-check; it proceeds to the real PDF-magic-bytes/size
    validation (which then 400s on the truncated fixture body — this test
    only asserts the pre-check itself didn't fire, i.e. no 413)."""
    resp = await client_as_user_a.post(
        f"/papers?workspace_id={seeded_users['workspace_a']}",
        files={"file": ("test.pdf", b"%PDF-1.4 tiny", "application/pdf")},
    )
    assert resp.status_code != 413
