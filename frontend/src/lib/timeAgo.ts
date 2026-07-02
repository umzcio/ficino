// One relative-time helper for the whole app (R10 DUP-8 — six drifted
// copies produced 'just now' / '0m ago' / '0m' for the same timestamp).
// Canonical behavior matches the original Alerts/FeedHistory/ExploreView
// variant; pass { suffix: false } for the compact Inbox/UserPostCard
// rendering ('5m' instead of '5m ago').
export function timeAgo(iso: string | Date, opts?: { suffix?: boolean }): string {
  const then = typeof iso === 'string' ? new Date(iso) : iso
  const diff = Date.now() - then.getTime()
  const mins = Math.floor(diff / 60000)
  const suffix = opts?.suffix === false ? '' : ' ago'
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m${suffix}`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h${suffix}`
  return `${Math.floor(hrs / 24)}d${suffix}`
}
