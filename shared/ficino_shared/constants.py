"""Cross-service constants (R10 DUP-14, DUP-18, BP-8).

Values consumed by BOTH containers live here. Service-local tuning knobs
stay in the service that owns them.
"""

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"
DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"
# NOTE: frontend/src/hooks/useWorkspaces.ts:7 mirrors DEFAULT_WORKSPACE_ID
# as a literal — keep them in sync.

# Signed-URL TTLs (seconds). Short default for live listings; long for
# media URLs persisted into feed posts.
SIGNED_URL_DEFAULT_TTL = 600
MEDIA_URL_TTL = 86400

# Chapter-row creation for reading lists. The state machine's initial
# condition ("first chapter unlocked, rest locked") is encoded once here
# and executed by both the api create/reorder endpoints and the worker's
# propose-ordering apply path (R10 DUP-18).
CHAPTER_INSERT_SQL = """INSERT INTO reading_list_chapters
             (reading_list_id, chapter_index, paper_ids, status)
           SELECT $1::uuid,
                  (row_num - 1)::int,
                  ARRAY[pid]::uuid[],
                  CASE WHEN row_num = 1 THEN 'unlocked' ELSE 'locked' END
           FROM unnest($2::uuid[]) WITH ORDINALITY AS t(pid, row_num)"""
