"""Plan 016: interactive API docs (/docs, /redoc, /openapi.json) are served
only when settings.environment == "development". In every other environment
they would be an unauthenticated inventory of every route, model, and
tunable parameter.

The app is constructed at import time, so the non-default environment cases
rebuild the app by reloading `main` under a mutated settings object (module
state is restored afterwards). ASGITransport is used so the lifespan — and
its DB pool — never fires, matching the conftest pattern.
"""
from __future__ import annotations

import importlib
from typing import AsyncGenerator

import httpx
import pytest_asyncio

import config
import main

DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")


async def _get(app, path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.get(path)


@pytest_asyncio.fixture
async def rebuilt_app() -> AsyncGenerator:
    """Rebuild main.app under a chosen environment, restoring module state."""
    original = config.settings.environment

    def _build(environment: str):
        config.settings.environment = environment
        return importlib.reload(main).app

    yield _build
    config.settings.environment = original
    importlib.reload(main)


async def test_docs_disabled_on_the_imported_app():
    """The suite never runs under ENVIRONMENT=development (conftest defaults
    it to "test"; the api container sets "production"), so the app imported
    at session start must already have docs gated off."""
    assert config.settings.environment != "development"
    for path in DOCS_PATHS:
        resp = await _get(main.app, path)
        assert resp.status_code == 404, f"{path} must be 404 outside development"


async def test_docs_disabled_in_production(rebuilt_app):
    app = rebuilt_app("production")
    for path in DOCS_PATHS:
        resp = await _get(app, path)
        assert resp.status_code == 404, f"{path} must be 404 outside development"


async def test_docs_enabled_in_development(rebuilt_app):
    app = rebuilt_app("development")
    for path in ("/docs", "/openapi.json"):
        resp = await _get(app, path)
        assert resp.status_code == 200, f"{path} must be served in development"
    resp = await _get(app, "/redoc")
    assert resp.status_code == 200
    assert "openapi" in (await _get(app, "/openapi.json")).json()
