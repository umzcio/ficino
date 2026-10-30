import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, seedUsers, testSql, USER_A_ID, USER_B_ID, type Seeded } from '../helpers/db.js';

const sql = testSql();
let seeded: Seeded;
beforeEach(async () => {
  await resetDb(sql);
  seeded = await seedUsers(sql);
});
const as = (id: string) => client(testApp({ user: { id, email: `${id}@ficino.dev`, display_name: 'U' } }));

async function setMeta(paperId: string, title: string, authors: string[], year: number | null, doi: string | null) {
  await sql`UPDATE papers SET title = ${title}, authors = ${authors}, year = ${year}, doi = ${doi} WHERE id = ${paperId}`;
}

describe('GET /citations/by-title', () => {
  it('formats APA by default and echoes format', async () => {
    await setMeta(seeded.paper_a, 'Deep Nets Rising', ['Ada Lovelace'], 2020, '10.1/x');
    const r = await as(USER_A_ID).get('/citations/by-title?title=deep%20nets');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      citation: 'Lovelace, A. (2020). Deep Nets Rising. https://doi.org/10.1/x',
      format: 'apa',
      title: 'Deep Nets Rising',
    });
  });

  it('mla, and unknown format echoed verbatim (falls back to APA)', async () => {
    await setMeta(seeded.paper_a, 'Deep Nets Rising', ['Ada Lovelace'], 2020, null);
    const mla = await (await as(USER_A_ID).get('/citations/by-title?title=Deep&format=mla')).json();
    expect(mla.citation).toBe('Lovelace, Ada. "Deep Nets Rising." 2020.');
    const odd = await (await as(USER_A_ID).get('/citations/by-title?title=Deep&format=chicago')).json();
    expect(odd.format).toBe('chicago');
    expect(odd.citation).toBe('Lovelace, A. (2020). Deep Nets Rising.');
  });

  it('ILIKE is unescaped: % matches anything', async () => {
    await setMeta(seeded.paper_a, 'Anything Goes', [], null, null);
    const r = await as(USER_A_ID).get('/citations/by-title?title=%25');
    expect(r.status).toBe(200);
    expect((await r.json()).title).toBe('Anything Goes');
  });

  it('only the first 80 code points of the title are matched', async () => {
    const t = 'x'.repeat(80);
    await setMeta(seeded.paper_a, t, [], null, null);
    const r = await as(USER_A_ID).get(`/citations/by-title?title=${t}zzzz`);
    expect(r.status).toBe(200);
  });

  it('missing title is 422; no match is 404; other users papers are invisible', async () => {
    expect((await as(USER_A_ID).get('/citations/by-title')).status).toBe(422);
    const nf = await as(USER_A_ID).get('/citations/by-title?title=zzz-nothing');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ detail: 'Paper not found' });
    await setMeta(seeded.paper_a, 'Secret A Paper', [], null, null);
    expect((await as(USER_B_ID).get('/citations/by-title?title=Secret')).status).toBe(404);
  });
});
