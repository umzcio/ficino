// Port of api/textutil.py.

/** Escape LIKE/ILIKE metacharacters so user input matches literally. Backslash first. */
export function escapeLike(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
