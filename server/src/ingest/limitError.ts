/**
 * A per-paper bound was passed (a PDF page or the paper's text over its character cap, the PDF thread over its heap
 * cap, the paper's text over its chunk ceiling). The same input fails the same way again, so it is not worth a retry.
 * Its own module so the chunker can throw it without loading MuPDF; `pdf.ts` re-exports it.
 */
export class PdfLimitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PdfLimitError';
  }
}
