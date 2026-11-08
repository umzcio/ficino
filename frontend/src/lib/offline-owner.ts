import { clearOfflineData } from './workspace-download'
import { safeLocal } from './safeLocal'

// The offline stores and the figure cache carry no user id, so they belong to
// whoever was signed in last. That id is remembered here (best-effort: the
// origin's localStorage may be full or blocked) so a different user, or a
// session that ended without an explicit sign-out, triggers a wipe.
const LAST_USER_KEY = 'ficino:lastUserId'

async function wipe(): Promise<void> {
  try { await clearOfflineData() } catch { /* best-effort */ }
}

/** Call before adopting a signed-in user. Wipes when a different user was stored last. */
export async function claimOfflineData(userId: string): Promise<void> {
  const last = safeLocal.get(LAST_USER_KEY)
  if (last !== null && last !== userId) await wipe()
  safeLocal.set(LAST_USER_KEY, userId)
}

/** Call when the session has ended (signed out or expired). */
export async function releaseOfflineData(): Promise<void> {
  await wipe()
  safeLocal.remove(LAST_USER_KEY)
}
