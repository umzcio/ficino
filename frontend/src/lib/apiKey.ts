// R10 W5 Task 3 item 5: whether ApiKeyInput's "Clear" button should be
// shown. The API never round-trips a configured secret's real value — GET
// /settings redacts it to the literal string "set" (api/routers/settings.py
// `_redact`) — so "set" is the only signal that a key is currently
// configured server-side. Pulled out as a plain predicate (rather than only
// inline in the component) so it's directly unit testable — this repo has
// no @testing-library/react to render ApiKeyInput itself.
export function isApiKeyConfigured(value: string): boolean {
  return value === 'set'
}
