"""Ficino API — FastAPI application entry point."""

from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import settings
from db.connection import close_pool, create_pool
from routers import alerts as alerts_router, bookmarks, feed, messages, papers, replies, search, settings as settings_router, tags, users, workspaces

logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifecycle: DB pool creation and teardown."""
    logger.info("startup", environment=settings.environment)
    await create_pool()
    yield
    await close_pool()
    logger.info("shutdown")


app = FastAPI(
    title="Ficino API",
    description="AI-powered academic discourse engine",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — permissive in dev, lock down in production
if settings.environment == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://ficino.ai", "https://ficino.local"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )

app.include_router(alerts_router.router)
app.include_router(bookmarks.router)
app.include_router(papers.router)
app.include_router(replies.router)
app.include_router(search.router)
app.include_router(feed.router)
app.include_router(messages.router)
app.include_router(settings_router.router)
app.include_router(tags.router)
app.include_router(users.router)
app.include_router(workspaces.router)

# Serve extracted figure images
app.mount("/figures", StaticFiles(directory="/app/figures"), name="figures")


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "ok", "service": "ficino-api"}
