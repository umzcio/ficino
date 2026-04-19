"""Ficino API — FastAPI application entry point."""

from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from config import settings
from constants import STUB_USER_ID, DEFAULT_WORKSPACE_ID
from csrf import CsrfMiddleware
from db.connection import close_pool, create_pool, get_db
from routers import alerts as alerts_router, annotations, bookmarks, citations, feed, figures as figures_router, likes, messages, papers, personas, reading_lists, replies, search, settings as settings_router, tags, user_posts, users, workspaces

logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifecycle: DB pool creation and teardown."""
    logger.info("startup", environment=settings.environment, auth_provider=settings.auth_provider)

    # Fail-closed: AUTH_PROVIDER=supabase with empty JWT secret would let
    # `jwt.decode(token, "", algorithms=["HS256"])` validate any attacker-
    # forged token, giving silent auth bypass / account takeover. Match the
    # pattern used by signed_url._resolve_signing_key.
    if settings.auth_provider == "supabase" and not settings.supabase_jwt_secret:
        raise RuntimeError(
            "SUPABASE_JWT_SECRET is required when AUTH_PROVIDER=supabase"
        )

    pool = await create_pool()

    # For AUTH_PROVIDER=none, ensure stub user + default workspace exist
    if settings.auth_provider == "none":
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO users (id, clerk_id, email)
                   VALUES ($1, 'stub', 'stub@ficino.dev')
                   ON CONFLICT (id) DO NOTHING""",
                STUB_USER_ID,
            )
            await conn.execute(
                """INSERT INTO corpora (id, user_id, name)
                   VALUES ($1, $2, 'Default')
                   ON CONFLICT (id) DO NOTHING""",
                DEFAULT_WORKSPACE_ID, STUB_USER_ID,
            )
        logger.info("stub_user_ensured")

    yield
    await close_pool()
    logger.info("shutdown")


app = FastAPI(
    title="Ficino API",
    description="AI-powered academic discourse engine",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — permissive in dev, lock down in production. Prod origins must come
# through CORS_ORIGINS so dev mode can't accidentally accept a prod origin.
if settings.environment == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://localhost:5173", "http://localhost:8000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    # Production: restrict allow_headers to what the frontend actually sends.
    # Wildcard allow_headers + credentials=true is unsafe per the CORS spec
    # and can enable request-smuggling-style tricks on misbehaving proxies.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Requested-With",
            "Accept",
            "X-CSRF-Token",
        ],
    )

# CSRF double-submit cookie protection.
# Order: CORS (preflight) → CSRF (reject bad state-changers) → SecurityHeaders.
app.add_middleware(CsrfMiddleware)

# Security headers
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if settings.environment != "development":
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
            response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co"
        return response

app.add_middleware(SecurityHeadersMiddleware)

# Auth provider + deployment-mode discovery endpoint (unauthenticated).
# Frontend calls this on boot to decide which login flow to show AND
# whether to hide LLM/API-key controls in Settings.
@app.get("/auth/provider")
async def get_auth_provider() -> dict[str, object]:
    return {
        "provider": settings.auth_provider,
        "public_deployment": settings.public_deployment,
    }

# Mount basic auth routes only when provider is basic
if settings.auth_provider == "basic":
    from auth.basic_routes import router as basic_auth_router
    app.include_router(basic_auth_router)

app.include_router(alerts_router.router)
app.include_router(annotations.router)
app.include_router(bookmarks.router)
app.include_router(citations.router)
app.include_router(likes.router)
app.include_router(papers.router)
app.include_router(personas.router)
app.include_router(replies.router)
app.include_router(search.router)
app.include_router(feed.router)
app.include_router(figures_router.router)
app.include_router(messages.router)
app.include_router(settings_router.router)
app.include_router(reading_lists.router)
app.include_router(tags.router)
app.include_router(user_posts.router)
app.include_router(users.router)
app.include_router(workspaces.router)

@app.get("/health")
@app.get("/healthz")
async def health() -> dict[str, str]:
    """Health check endpoint. /healthz is the Railway/Kubernetes convention;
    /health is what docker-compose's healthcheck (and our own logs) look for.
    Both return the same payload."""
    return {"status": "ok", "service": "ficino-api"}
