// Shared-origin storage guard (deployment CLAUDE.md: all apps on this origin
// share one ~5MB bucket; a full bucket makes even tiny setItem throw).
export const safeLocal = {
  get(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } },
  set(key: string, value: string): boolean { try { localStorage.setItem(key, value); return true } catch { return false } },
  remove(key: string): void { try { localStorage.removeItem(key) } catch { /* best-effort */ } },
}
