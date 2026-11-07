/**
 * Writes test/fixtures/sample.pdf: a 3-page PDF built from raw objects. It uses only the base-14 fonts
 * Times-Roman, Times-Bold, Helvetica and Helvetica-Bold (WinAnsi), plus one Type0 font with a ToUnicode map
 * for two CJK characters, and has no images. All text is original to this file.
 *
 * Run from server/: npx tsx test/fixtures/build-sample-pdf.ts
 * The sample.* goldens in test/fixtures/goldens are the Python extractor's output for it
 * (see test/fixtures/goldens/README.md, tag `python-final`).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./sample.pdf', import.meta.url));

/** Encode text as a PDF literal string in WinAnsi (only the non-ASCII characters this file uses). */
function lit(text: string): string {
  const winAnsi: Record<string, number> = { é: 0xe9, ï: 0xef, ñ: 0xf1, '—': 0x97 };
  let out = '(';
  for (const ch of text) {
    const code = winAnsi[ch] ?? ch.charCodeAt(0);
    if (code > 0x7e && winAnsi[ch] === undefined) throw new Error(`no WinAnsi code for ${ch}`);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code > 0x7e) out += `\\${code.toString(8)}`;
    else out += ch;
  }
  return out + ')';
}

/** Greedy word wrap by character count (Times at 10 pt averages well under 5 pt per character). */
function wrap(text: string, max = 88): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && cur.length + 1 + word.length > max) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

const FONT = { roman: 'F1', bold: 'F2', helv: 'F3', helvBold: 'F4', cjk: 'F5' } as const;
type FontKey = keyof typeof FONT;

class Page {
  ops: string[] = [];
  y = 740;
  text(font: FontKey, size: number, x: number, y: number, s: string): void {
    this.ops.push(`BT /${FONT[font]} ${size} Tf ${x} ${y} Td ${lit(s)} Tj ET`);
  }
  /** A standalone line at the left margin, advancing the cursor. */
  line(font: FontKey, size: number, s: string, gapAfter = 0.6): void {
    this.text(font, size, 72, this.y, s);
    this.y -= size * 1.2 + size * gapAfter;
  }
  paragraph(s: string): void {
    for (const l of wrap(s)) {
      this.text('roman', 10, 72, this.y, l);
      this.y -= 12;
    }
    this.y -= 8;
  }
  raw(op: string): void {
    this.ops.push(op);
  }
}

const P1 = [
  'Reading groups are a common way for small teams to keep up with a field, yet little is known about how ' +
    'attention moves around the table during a session. This study followed nine informal groups over one term ' +
    'and recorded who spoke, who took notes, and which passages drew repeated comment. We found that attention ' +
    'clusters around a few dense paragraphs, that quiet members often return to those paragraphs later in writing, ' +
    'and that a short written prompt before the meeting spreads discussion more evenly. These results suggest ' +
    'simple, low-cost changes for anyone who runs a reading group.',
  'Most advice about reading groups is anecdotal. Organizers swap tips about snacks, timing, and how to choose a ' +
    'paper, but few have looked closely at what actually happens once the discussion starts. Does everyone engage ' +
    'with the same parts of a text? Do the loudest voices set the agenda, or do the quieter members steer the ' +
    'conversation in ways that are easy to miss? We wanted to answer these questions with careful observation ' +
    'rather than surveys, because people tend to remember a lively meeting as more balanced than it really was.',
  'Our approach was deliberately modest. We did not record audio or video, and we did not ask anyone to change how ' +
    'they ran their meetings. Instead, a single observer sat in on each session with a seating chart and a simple ' +
    'coding sheet. Every time a member spoke, the observer noted the time, the speaker, and the page or paragraph ' +
    'under discussion. After each meeting, members were invited to send a short note about anything they wished ' +
    'they had said. Those notes turned out to be the most revealing part of the data.',
];

const P2 = [
  'Nine groups took part, with between four and eleven members each. Six groups met weekly and three met every ' +
    'other week. Sessions lasted between forty and ninety minutes. In total we observed seventy-two sessions and ' +
    'coded just over four thousand speaking turns. Two coders worked through a shared subset of twelve sessions to ' +
    'check agreement, and they matched on the paragraph being discussed in nearly nine out of ten turns. Where they ' +
    'disagreed, the cause was usually a speaker who jumped between two nearby sections in a single remark.',
  'Halfway through the term, four of the groups agreed to try a small change. Before each meeting, members wrote ' +
    'two or three sentences naming the passage they found most puzzling. The organizer read these aloud at the ' +
    'start of the session. The other five groups carried on as before and served as a comparison.',
];

const P3 = [
  'Attention was far from even. In a typical session, roughly a fifth of the paragraphs in the assigned reading ' +
    'drew more than half of all comments. These were rarely the opening or closing sections; more often they were ' +
    'dense passages that introduced a new method or a surprising claim. Members who spoke least during the meeting ' +
    'were the most likely to send a follow-up note, and their notes pointed to the same dense paragraphs about two ' +
    'thirds of the time. In other words, quiet members were paying attention to the right places but were not ' +
    'getting a chance to say so.',
  'The written prompt helped. In groups that used it, the share of turns taken by the two most active members ' +
    'fell from about one half to about one third, and the number of members who spoke at least once rose in almost ' +
    'every session. The comparison groups showed no such change. The effect appeared within two weeks and held ' +
    'steady for the rest of the term.',
  'These findings come with limits. The groups were all volunteers, the observer could not be blind to which ' +
    'groups used the prompt, and one term is a short window. Still, the pattern was consistent across groups of ' +
    'very different sizes, and the change asked of organizers was tiny. A few minutes of writing before the ' +
    'meeting cost nothing and gave quieter members a way into the conversation.',
];

const REFS = [
  'Alder, R. and Moss, T. (2019). Notes from the margin: informal study circles. Journal of Everyday Learning, 4(2), 11-29.',
  'Brook, L. (2021). Turn-taking in small groups. Small Group Studies Quarterly, 9(1), 40-58.',
  'Fenwick, P., Hale, S. and Ortiz, M. (2023). Low-cost interventions for balanced discussion. Teaching Notes, 15, 1-12.',
];

const page1 = new Page();
page1.line('helvBold', 20, 'Quiet Attention in Small Reading Groups', 0.8);
page1.line('helv', 10, 'A. Writer and B. Author', 1.2);
page1.line('bold', 10, 'Abstract');
page1.paragraph(P1[0]!);
page1.line('bold', 10, '1. Introduction');
page1.paragraph(P1[1]!);
page1.paragraph(P1[2]!);
page1.line('roman', 10, 'FIELD NOTES SUMMARY');
page1.paragraph(
  'A recurring phrase in the notes was a quiet apology for not speaking up. One member wrote that the group ' +
    'had moved on before she found the words, and that the paragraph stayed with her all week.',
);
// One line of non-ASCII text: WinAnsi Helvetica and the CJK Type0 font in a single text object.
page1.raw(`BT /F3 10 Tf 72 ${page1.y} Td ${lit('Café naïve — ')} Tj /F5 10 Tf <00010002> Tj /F3 10 Tf ${lit(' ñ')} Tj ET`);
page1.y -= 20;

const page2 = new Page();
page2.line('helv', 12, '2.1 Methods and Materials');
page2.paragraph(P2[0]!);
page2.paragraph(P2[1]!);
page2.line('bold', 10, '(see below)');
// Bar chart: axes plus four filled bars, then the caption.
const chartX = 200;
const chartBase = 300;
page2.raw('0 0 0 RG 1 w');
page2.raw(`${chartX} ${chartBase} m ${chartX + 240} ${chartBase} l S`);
page2.raw(`${chartX} ${chartBase} m ${chartX} ${chartBase + 180} l S`);
const bars = [
  { h: 90, gray: 0.25 },
  { h: 150, gray: 0.45 },
  { h: 120, gray: 0.65 },
  { h: 60, gray: 0.8 },
];
bars.forEach((b, i) => {
  page2.raw(`${b.gray} g ${chartX + 20 + i * 55} ${chartBase} 40 ${b.h} re f`);
});
page2.raw('0 g');
['A', 'B', 'C', 'D'].forEach((label, i) => {
  page2.text('helv', 8, chartX + 34 + i * 55, chartBase - 12, `Group ${label}`);
});
page2.text('roman', 9, chartX, chartBase - 32, 'Figure 1: Mean scores by group.');
page2.y = chartBase - 60;
page2.paragraph(
  'Figure 1 shows the mean balance score for each group at the end of term. Groups A and B used the written ' +
    'prompt; groups C and D did not.',
);

const page3 = new Page();
page3.line('roman', 11, '3 Results');
page3.paragraph(P3[0]!);
page3.paragraph(P3[1]!);
page3.paragraph(P3[2]!);
page3.line('bold', 10, 'References');
for (const r of REFS) page3.paragraph(r);

// --- Serialize ---------------------------------------------------------------------------------------------
const objects: string[] = [];
const add = (body: string): number => {
  objects.push(body);
  return objects.length;
};
const stream = (dict: string, data: string): string =>
  `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;

const catalog = add('PLACEHOLDER');
const pagesObj = add('PLACEHOLDER');
const base14 = (name: string): number => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
const f1 = base14('Times-Roman');
const f2 = base14('Times-Bold');
const f3 = base14('Helvetica');
const f4 = base14('Helvetica-Bold');
const toUnicode = add(
  stream(
    '',
    [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Sample-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      '2 beginbfchar',
      '<0001> <6771>',
      '<0002> <4EAC>',
      'endbfchar',
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end',
    ].join('\n'),
  ),
);
const cidFont = add(
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SampleCJK ' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
    '/FontDescriptor << /Type /FontDescriptor /FontName /SampleCJK /Flags 4 /FontBBox [0 -120 1000 880] ' +
    '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> /DW 1000 >>',
);
const f5 = add(
  `<< /Type /Font /Subtype /Type0 /BaseFont /SampleCJK /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] ` +
    `/ToUnicode ${toUnicode} 0 R >>`,
);
const resources = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R /F4 ${f4} 0 R /F5 ${f5} 0 R >> >>`;
const pageIds: number[] = [];
for (const p of [page1, page2, page3]) {
  const content = add(stream('', p.ops.join('\n')));
  pageIds.push(
    add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${content} 0 R >>`,
    ),
  );
}
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

let pdf = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
const offsets: number[] = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

writeFileSync(OUT, Buffer.from(pdf, 'latin1'));
console.log(`wrote ${OUT} (${pageIds.length} pages, ${Buffer.byteLength(pdf, 'latin1')} bytes)`);
