"""CSRF protection via double-submit cookie.

GET requests land a random token in a `ficino_csrf` cookie (readable by JS,
so SameSite=Lax + Secure-in-prod is the defense against cross-origin reads).
State-changing requests (POST/PUT/DELETE/PATCH) must echo the cookie value
in the `X-CSRF-Token` header. Mismatch → 403.

Exempt paths: explicit list of endpoints where the client may not yet have
a cookie (login, register). Health + CORS preflight are implicitly exempt
by method.
"""
from __future__ import annotations

import secrets
import structlog
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from config import settings

logger = structlog.get_logger(__name__)

CSRF_COOKIE_NAME = "ficino_csrf"
CSRF_HEADER_NAME = "x-csrf-token"
CSRF_PROTECTED_METHODS = {"POST", "PUT", "DELETE", "PATCH"}

# Exempt endpoints (exact path match, no prefix wildcards). Keep this list
# minimal — every entry is a CSRF carve-out.
CSRF_EXEMPT_PATHS = {
    "/auth/login",
    "/auth/register",
}


class CsrfMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        method = request.method.upper()

        # Previously: full bypass when AUTH_PROVIDER=none. That left the
        # self-hosted single-user deployment wide open to CSRF from any
        # site the user happened to visit while logged in — the threat
        # model isn't "local attacker only," it's "any origin can forge
        # a request against localhost / the public deployment."
        # The frontend already reads the ficino_csrf cookie and echoes it
        # as X-CSRF-Token on mutating requests, so turning enforcement on
        # regardless of auth_provider is a no-op for a conforming client.

        # Enforce for state-changing methods only
        if method in CSRF_PROTECTED_METHODS and request.url.path not in CSRF_EXEMPT_PATHS:
            cookie = request.cookies.get(CSRF_COOKIE_NAME)
            header = request.headers.get(CSRF_HEADER_NAME)
            if not cookie or not header or not secrets.compare_digest(cookie, header):
                logger.warn(
                    "csrf_validation_failed",
                    method=method, path=request.url.path,
                    has_cookie=bool(cookie), has_header=bool(header),
                )
                return Response(
                    content='{"detail":"CSRF validation failed"}',
                    status_code=403,
                    media_type="application/json",
                )

        response = await call_next(request)

        # Issue (or refresh) the cookie on any GET/HEAD response so a
        # just-authenticated client gets a token before its next POST.
        if method in ("GET", "HEAD") and CSRF_COOKIE_NAME not in request.cookies:
            token = secrets.token_urlsafe(32)
            # Domain is parameterized because a hosted deploy with frontend
            # and api on separate subdomains (ficino.app / api.ficino.app)
            # needs Domain=.ficino.app so ficino.app JS can actually read
            # the cookie and echo it back as the header. Self-host runs
            # same-origin and should use host-only cookies (cookie_domain="").
            cookie_kwargs = {
                "key": CSRF_COOKIE_NAME,
                "value": token,
                "httponly": False,  # JS needs to read it
                "samesite": "lax",
                "secure": settings.environment != "development",
                "max_age": 60 * 60 * 24 * 7,  # 7d
                "path": "/",
            }
            if settings.cookie_domain:
                cookie_kwargs["domain"] = settings.cookie_domain
            response.set_cookie(**cookie_kwargs)

        return response
