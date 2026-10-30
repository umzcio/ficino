import type { Sql } from '../db/sql.js';
import { DEFAULT_WORKSPACE_ID, STUB_USER_ID } from '../shared/constants.js';

/** AUTH_PROVIDER=none startup: the stub user and its Default workspace (C §1.0). Idempotent. */
export async function ensureStubUser(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO users (id, clerk_id, email)
    VALUES (${STUB_USER_ID}, 'stub', 'stub@ficino.dev')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO corpora (id, user_id, name)
    VALUES (${DEFAULT_WORKSPACE_ID}, ${STUB_USER_ID}, 'Default')
    ON CONFLICT (id) DO NOTHING`;
}
