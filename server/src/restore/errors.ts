/** A restore precondition or integrity check failed. Messages name tables, columns and counts, never row content. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}
