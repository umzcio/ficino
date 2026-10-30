import { describe, expect, it } from 'vitest';
import { formatApa, formatMla } from '../../src/citations/format.js';

const A21 = Array.from({ length: 21 }, (_, i) => `First${i} Last${i}`);
const authorsN = (n: number) => Array.from({ length: n }, (_, i) => `Author${String(i + 1).padStart(2, '0')} Last${String(i + 1).padStart(2, '0')}`);

describe('citation formatters (golden vectors from api/routers/citations.py)', () => {
  it.each([
    [['Deep Nets', [], 2020, null], 'Unknown Author (2020). Deep Nets.', '"Deep Nets." 2020.'],
    [['Deep Nets', ['Ada Lovelace'], 2020, '10.1/x'], 'Lovelace, A. (2020). Deep Nets. https://doi.org/10.1/x', 'Lovelace, Ada. "Deep Nets." 2020. https://doi.org/10.1/x.'],
    [['Deep Nets', ['Ada Lovelace', 'Alan Turing'], null, null], 'Lovelace, A., & Turing, A. (n.d.). Deep Nets.', 'Lovelace, Ada, and Alan Turing. "Deep Nets." .'],
    [['Deep Nets', ['Ada B Lovelace', 'Turing', 'Grace Hopper'], 2021, '10.2/y'], 'Lovelace, A. B., Turing, & Hopper, G. (2021). Deep Nets. https://doi.org/10.2/y', 'Lovelace, Ada B, et al.. "Deep Nets." 2021. https://doi.org/10.2/y.'],
    [['T', A21, 1999, null], 'Last0, F., Last1, F., Last2, F., Last3, F., Last4, F., Last5, F., Last6, F., Last7, F., Last8, F., Last9, F., Last10, F., Last11, F., Last12, F., Last13, F., Last14, F., Last15, F., Last16, F., Last17, F., Last18, F., ... Last20, F. (1999). T.', 'Last0, First0, et al.. "T." 1999.'],
  ])('%j', ([t, a, y, d], apa, mla) => {
    expect(formatApa(t as string, a as string[], y as number | null, d as string | null)).toBe(apa);
    expect(formatMla(t as string, a as string[], y as number | null, d as string | null)).toBe(mla);
  });

  it('test_apa_format_exactly_20_authors_lists_all_20', () => {
    const authors = authorsN(20);
    const c = formatApa('Some Title', authors, 2020, null);
    for (const a of authors) expect(c).toContain(a.split(' ').at(-1));
    expect(c).toContain(', & ');
  });

  it('test_apa_format_21_authors_first_19_then_ellipsis_then_true_last', () => {
    const authors = authorsN(21);
    const c = formatApa('Some Title', authors, 2020, null);
    expect(c).toContain(authors[20]!.split(' ')[1]);
    expect(c).not.toContain(authors[19]!.split(' ')[1]);
    for (const a of authors.slice(0, 19)) expect(c).toContain(a.split(' ')[1]);
    expect(c).toContain('...');
  });

  it('single "unknown"/empty author is Unknown Author / no MLA author', () => {
    expect(formatApa('T', ['Unknown'], 2020, null)).toBe('Unknown Author (2020). T.');
    expect(formatMla('T', [''], 2020, null)).toBe('"T." 2020.');
  });
});
