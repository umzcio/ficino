"""R10 API-6/BP-13: `GET /personas` and `GET /settings/ollama-models` were
the only two routes in the API with no `Depends(get_current_user)` — an
unauthenticated caller could enumerate persona metadata, or (worse) trigger
a 10s outbound HTTP call to the operator's Ollama instance and read back the
installed model list. Both now require an authenticated session."""
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_list_personas_requires_auth(client_unauthenticated):
    resp = await client_unauthenticated.get("/personas")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_ollama_models_requires_auth(client_unauthenticated):
    resp = await client_unauthenticated.get("/settings/ollama-models")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_personas_still_works_authenticated(client_as_user_a):
    """Frontend-caller gate: `listPersonas()` (frontend/src/lib/api.ts:264-265)
    goes through the shared `request()` helper, which sends
    `credentials: 'include'` on every call — an authenticated session's
    cookie/token keeps reaching this route unchanged."""
    resp = await client_as_user_a.get("/personas")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
