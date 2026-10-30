// Port of api/routers/citations.py `_format_apa` / `_format_mla`. Quirks are intentional
// (e.g. "et al.." and the bare "." when the MLA year is missing).

/** Python `str.split()` with no args: trims and splits on whitespace runs. */
function pySplit(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Python `p[0]`: the first code point. */
function first(p: string): string {
  return Array.from(p)[0] ?? '';
}

function isUnknownOnly(authors: string[]): boolean {
  return authors.length === 1 && ['unknown', ''].includes(authors[0]!.toLowerCase());
}

function apaName(a: string): string {
  const parts = pySplit(a);
  return parts.length > 1 ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).map(first).join('. ')}.` : a;
}

export function formatApa(title: string, authors: string[], year: number | null, doi: string | null): string {
  let authorStr: string;
  if (authors.length === 0 || isUnknownOnly(authors)) {
    authorStr = 'Unknown Author';
  } else if (authors.length === 1) {
    authorStr = apaName(authors[0]!);
  } else if (authors.length === 2) {
    authorStr = `${apaName(authors[0]!)}, & ${apaName(authors[1]!)}`;
  } else {
    const formatted = authors.map(apaName);
    authorStr =
      authors.length > 20
        ? `${formatted.slice(0, 19).join(', ')}, ... ${formatted[formatted.length - 1]}`
        : `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
  }
  const yearStr = year ? `(${year})` : '(n.d.)';
  const doiStr = doi ? ` https://doi.org/${doi}` : '';
  return `${authorStr} ${yearStr}. ${title}.${doiStr}`;
}

export function formatMla(title: string, authors: string[], year: number | null, doi: string | null): string {
  let authorStr: string;
  const p1 = authors.length ? pySplit(authors[0]!) : [];
  const lead = p1.length > 1 ? `${p1[p1.length - 1]}, ${p1.slice(0, -1).join(' ')}` : null;
  if (authors.length === 0 || isUnknownOnly(authors)) {
    authorStr = '';
  } else if (authors.length === 1) {
    authorStr = lead ?? authors[0]!;
  } else if (authors.length === 2) {
    authorStr = `${lead ?? authors[0]!}, and ${authors[1]}`;
  } else {
    authorStr = `${lead ?? authors[0]!}, et al.`;
  }
  const yearStr = year ? String(year) : '';
  const doiStr = doi ? ` https://doi.org/${doi}.` : '';
  return authorStr ? `${authorStr}. "${title}." ${yearStr}.${doiStr}` : `"${title}." ${yearStr}.${doiStr}`;
}
