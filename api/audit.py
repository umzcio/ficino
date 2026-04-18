"""Audit log recording.

Call `record_audit()` from within a route handler to persist an entry.
The helper never raises — failures log + swallow so the audit path can't
break the actual operation.
"""
from __future__ import annotations

import asyncpg
import structlog
from fastapi import Request

from auth.models import AuthUser

logger = structlog.get_logger(__name__)


async def record_audit(
    db: asyncpg.Connection,
    request: Request,
    user: AuthUser,
    *,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    metadata: dict | None = None,
    status_code: int = 200,
) -> None:
    """Persist an audit-log row. Never raises.

    `action` convention: `"<resource>.<verb>"` (e.g. "paper.delete", "workspace.rename").
    Include the caller's IP from X-Real-IP (set by nginx to $remote_addr) —
    not X-Forwarded-For, whose first hop is attacker-controlled under nginx's
    `$proxy_add_x_forwarded_for` and would poison the audit log.
    """
    try:
        real_ip = request.headers.get("x-real-ip", "").strip()
        ip = real_ip or (request.client.host if request.client else None)
        ua = request.headers.get("user-agent", "")[:500]
        import json
        await db.execute(
            """INSERT INTO audit_log
               (user_id, action, resource_type, resource_id, metadata, ip, user_agent, status_code)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)""",
            user.id, action, resource_type, resource_id,
            json.dumps(metadata or {}), ip, ua, status_code,
        )
    except Exception as e:
        logger.warn("audit_log_write_failed", error_type=type(e).__name__, error=str(e)[:200])
