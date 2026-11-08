// A host name with an optional port; the class has no ':', so the port group is unambiguous.
const NAME_RE = /^([a-z0-9_.-]+)(?::\d{1,5})?$/;
// A bracketed IPv6 literal with an optional port.
const BRACKET_RE = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/;

/**
 * The canonical host name in a Host header value (`name[:port]` or `[v6][:port]`): lowercased, port and IPv6
 * brackets removed, one trailing dot dropped, IP literals in the URL parser's canonical form (`[0:0::1]` is
 * `::1`). Returns null for anything else (userinfo, a path, whitespace, a bad port, an unbracketed IPv6
 * literal, non-ASCII), so a malformed value can never match an allowed name.
 */
export function normalizeHost(raw: string): string | null {
  const s = raw.toLowerCase();
  const bracketed = BRACKET_RE.exec(s);
  const name = bracketed ? `[${bracketed[1]}]` : NAME_RE.exec(s)?.[1];
  if (name === undefined) return null;
  let host: string;
  try {
    host = new URL(`http://${name}/`).hostname;
  } catch {
    return null;
  }
  if (host.startsWith('[')) return host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host === '' ? null : host;
}
