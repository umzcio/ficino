import * as mupdf from 'mupdf';

/** Save `pdf` to bytes and free it. */
function save(pdf: mupdf.PDFDocument): Uint8Array {
  try {
    const buf = pdf.saveToBuffer('compress');
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    pdf.destroy();
  }
}

/** One letter page per entry, each drawing that many 'a' glyphs in 1 pt Helvetica (one text line per 1000). */
export function glyphPages(counts: number[]): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  const font = pdf.addSimpleFont(new mupdf.Font('Helvetica'));
  for (const n of counts) {
    const rows: string[] = [];
    for (let left = n; left > 0; left -= 1000) rows.push(`(${'a'.repeat(Math.min(1000, left))}) '`);
    const contents = `BT /F1 1 Tf 1.2 TL 10 780 Td ${rows.join(' ')} ET`;
    pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, { Font: { F1: font } }, contents));
  }
  return save(pdf);
}

/**
 * A one-page PDF of nested form XObjects: the page draws form `depth`, and every form draws the one below it
 * `fanout` times, so the page runs `leaf` fanout^depth times from a file of a couple of kilobytes.
 */
export function formBomb(depth: number, fanout: number, leaf: string): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  const font = pdf.addSimpleFont(new mupdf.Font('Helvetica'));
  const form = (body: string, resources: Record<string, unknown>) =>
    pdf.addStream(body, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: resources });
  let inner = form(leaf, { Font: { F1: font } });
  const draw = Array.from({ length: fanout }, () => '/X Do').join('\n');
  for (let d = 0; d < depth; d++) inner = form(draw, { XObject: { X: inner } });
  pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, { XObject: { X: inner } }, '/X Do'));
  return save(pdf);
}
