"""Cross-service constants (R10 DUP-14, DUP-18, BP-8).

Values consumed by BOTH containers live here. Service-local tuning knobs
stay in the service that owns them.
"""

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"
DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"
# NOTE: frontend/src/hooks/useWorkspaces.ts:7 mirrors DEFAULT_WORKSPACE_ID
# as a literal — keep them in sync.

# Local-dev/CI default DSN (docker-compose service name "postgres", the
# same ficino/ficino creds docker-compose.yml seeds a fresh volume with).
# R10.5 DUP-14 residual: this literal was duplicated identically across
# api/config.py, worker/lib/db.py, both services' test conftests, and two
# infra/postgres/*.py one-off scripts — six copies that could silently
# drift. Real deployments always set DATABASE_URL explicitly; this is
# only the fallback for a fresh self-host checkout or test run.
DEFAULT_DATABASE_URL = "postgresql://ficino:ficino@postgres:5432/ficino"

# Signed-URL TTLs (seconds). Short default for live listings; long for
# media URLs persisted into feed posts.
SIGNED_URL_DEFAULT_TTL = 600
MEDIA_URL_TTL = 86400

# Chapter-row creation for reading lists. The state machine's initial
# condition ("first chapter unlocked, rest locked") is encoded once here
# and executed by both the api create/apply-ordering endpoints and the
# worker's propose-ordering apply path (R10 DUP-18). Reorder now uses its
# own REORDER_CHAPTER_INSERT_SQL (R10 T11) — it doesn't reset progress
# back to "first chapter unlocked", so it can't reuse this one.
CHAPTER_INSERT_SQL = """INSERT INTO reading_list_chapters
             (reading_list_id, chapter_index, paper_ids, status)
           SELECT $1::uuid,
                  (row_num - 1)::int,
                  ARRAY[pid]::uuid[],
                  CASE WHEN row_num = 1 THEN 'unlocked' ELSE 'locked' END
           FROM unnest($2::uuid[]) WITH ORDINALITY AS t(pid, row_num)"""
