/**
 * Manual check (not in CI): run the TS extraction on every PDF in <dir> and write the results to <out>:
 *   <name>.ts.md          extractTextMarkdown
 *   <name>.ts.pages.json  extractPagesText
 * Compare them with the Python outputs from test/fixtures/goldens/gen/pdf_text.py (see its README).
 *
 * Usage (from server/): npx tsx scripts/compare-extraction.ts <dir> <out>
 * Never point <out> inside the repo when <dir> holds private papers.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { closePdf, extractPagesText, extractTextMarkdown, openPdf } from '../src/ingest/pdf.js';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error('usage: compare-extraction.ts <dir> <out>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()) {
  const name = basename(file, '.pdf');
  const started = performance.now();
  try {
    const doc = openPdf(new Uint8Array(readFileSync(join(dir, file))));
    try {
      const md = extractTextMarkdown(doc);
      writeFileSync(join(out, `${name}.ts.md`), md);
      writeFileSync(join(out, `${name}.ts.pages.json`), `${JSON.stringify(extractPagesText(doc), null, 2)}\n`);
      const ms = Math.round(performance.now() - started);
      console.log(`${name}: ${md.split('\n').length} lines (${ms} ms)`);
    } finally {
      closePdf(doc);
    }
  } catch (err) {
    console.log(`${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
}
