import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createSql, type Sql } from '../../src/db/sql.js';
import { parseDump, publicBlocks, type CopyBlock } from '../../src/restore/dump.js';
import { RestoreError } from '../../src/restore/errors.js';
import { createScratchDb } from '../helpers/db.js';
import { buildSyntheticDump, copyText, SECRET_MARKER, SYN, SYNTHETIC_POST_COUNT } from '../helpers/syntheticArchive.js';

const block = (blocks: CopyBlock[], schema: string, table: string): CopyBlock | undefined =>
  blocks.find((b) => b.schema === schema && b.table === table);

describe('parseDump', () => {
  it('parses every COPY block with its columns and rows', () => {
    const blocks = parseDump(buildSyntheticDump());
    const users = blocks.find((b) => b.schema === 'public' && b.table === 'users')!;
    expect(users.columns).toContain('id');
    expect(users.rows).toHaveLength(2);
    expect(blocks.some((b) => b.schema === 'auth')).toBe(true);
  });

  it('keeps only public data and skips personas', () => {
    const tables = publicBlocks(parseDump(buildSyntheticDump())).map((b) => b.table);
    expect(tables).not.toContain('personas');
    expect(tables).toContain('feed_posts');
    expect(JSON.stringify(publicBlocks(parseDump(buildSyntheticDump())))).not.toContain(SECRET_MARKER);
  });

  it('accepts unquoted identifiers', () =>
    expect(parseDump('COPY public.tags (id, name) FROM stdin;\na\tb\n\\.\n')[0]).toMatchObject({
      schema: 'public',
      table: 'tags',
      columns: ['id', 'name'],
      rows: ['a\tb'],
    }));

  it('treats an escaped backslash-dot inside data as data', () =>
    expect(parseDump('COPY "public"."tags" ("id") FROM stdin;\n\\\\.\n\\.\n')[0]!.rows).toEqual(['\\\\.']));

  it('rejects an unterminated block', () =>
    expect(() => parseDump('COPY "public"."tags" ("id") FROM stdin;\nx\n')).toThrow(/public\.tags is not terminated/));

  it('throws a RestoreError for an unterminated block', () =>
    expect(() => parseDump('COPY public.tags (id) FROM stdin;\n')).toThrow(RestoreError));

  it('unquotes doubled quotes and keeps quoted case and punctuation', () =>
    expect(parseDump('COPY "Pub"."we""ird" ("a,b", "C", d) FROM stdin;\n\\.\n')[0]).toMatchObject({
      schema: 'Pub',
      table: 'we"ird',
      columns: ['a,b', 'C', 'd'],
      rows: [],
    }));

  it('ignores SET, \\restrict, comments, DDL and COPY statements that are not FROM stdin', () => {
    const text = [
      '\\restrict abc',
      'SET client_encoding = \'UTF8\';',
      '-- COPY public.tags (id) FROM stdin;',
      'CREATE TABLE x (id int);',
      'COPY public.tags (id) TO stdout;',
      'COPY public.tags (id) FROM stdin;',
      '1',
      '\\.',
      'SELECT pg_catalog.setval(\'s\', 1, false);',
      '\\unrestrict abc',
      '',
    ].join('\n');
    expect(parseDump(text)).toEqual([{ schema: 'public', table: 'tags', columns: ['id'], rows: ['1'] }]);
  });

  it('accepts CRLF line endings', () =>
    expect(parseDump('COPY public.tags (id) FROM stdin;\r\na\r\n\\.\r\n')[0]!.rows).toEqual(['a']));

  it('keeps empty data lines inside a block', () =>
    expect(parseDump('COPY public.tags (id) FROM stdin;\n\n\\.\n')[0]!.rows).toEqual(['']));

  it('rejects a FROM stdin COPY it cannot parse rather than dropping its rows', () => {
    expect(() => parseDump('COPY public.tags FROM stdin;\nx\n\\.\n')).toThrow(RestoreError);
    expect(() => parseDump('COPY public.tags (id FROM stdin;\nx\n\\.\n')).toThrow(/line 1/);
    expect(() => parseDump('COPY "public.tags (id) FROM stdin;\nx\n\\.\n')).toThrow(RestoreError);
  });
});

describe('publicBlocks', () => {
  const blocks: CopyBlock[] = [
    { schema: 'public', table: 'users', columns: ['id'], rows: [] },
    { schema: 'public', table: 'schema_migrations', columns: ['version'], rows: [] },
    { schema: 'public', table: 'personas', columns: ['key'], rows: [] },
    { schema: 'auth', table: 'users', columns: ['id'], rows: [] },
    { schema: 'storage', table: 'objects', columns: ['id'], rows: [] },
  ];

  it('skips personas and schema_migrations by default', () =>
    expect(publicBlocks(blocks).map((b) => `${b.schema}.${b.table}`)).toEqual(['public.users']));

  it('takes a custom skip set', () =>
    expect(publicBlocks(blocks, new Set(['users'])).map((b) => b.table)).toEqual(['schema_migrations', 'personas']));
});

describe('copyText', () => {
  it('escapes COPY text format', () => {
    expect(copyText(null)).toBe('\\N');
    expect(copyText('a\\b\tc\nd\re')).toBe('a\\\\b\\tc\\nd\\re');
    expect(copyText(true)).toBe('t');
    expect(copyText(false)).toBe('f');
    expect(copyText(3)).toBe('3');
    expect(copyText(['x', 'y'])).toBe('{x,y}');
    expect(copyText({ a: 'q"\\' })).toBe('{"a":"q\\\\"\\\\\\\\"}');
  });
});

describe('buildSyntheticDump', () => {
  const blocks = parseDump(buildSyntheticDump());

  it('is shaped like a pg_dump with auth and storage blocks holding the secret marker', () => {
    const text = buildSyntheticDump();
    expect(text).toMatch(/^\\restrict /m);
    expect(text).toMatch(/^\\unrestrict /m);
    expect(text).toMatch(/^SET session_replication_role = replica;$/m);
    expect(block(blocks, 'auth', 'users')!.rows.join('\n')).toContain(SECRET_MARKER);
    expect(block(blocks, 'auth', 'refresh_tokens')!.rows.join('\n')).toContain(SECRET_MARKER);
    expect(block(blocks, 'storage', 'objects')).toBeDefined();
    expect(block(blocks, 'public', 'personas')!.rows.join('\n')).toContain('/personas/x.png');
  });

  it('every row has as many fields as its column list', () => {
    for (const b of blocks) for (const r of b.rows) expect(r.split('\t'), `${b.schema}.${b.table}`).toHaveLength(b.columns.length);
  });

  it('options change only what they name', () => {
    const extra = parseDump(buildSyntheticDump({ extraColumn: true }));
    expect(block(extra, 'public', 'users')!.columns).toContain('legacy_col');
    expect(block(blocks, 'public', 'users')!.columns).not.toContain('legacy_col');

    const second = parseDump(buildSyntheticDump({ secondOwner: true }));
    expect(block(second, 'public', 'papers')!.rows).toHaveLength(3);
    expect(block(second, 'public', 'papers')!.rows.some((r) => r.includes(SYN.orphan))).toBe(true);

    const noDefault = parseDump(buildSyntheticDump({ omitDefaultCorpus: true }));
    expect(block(noDefault, 'public', 'corpora')!.rows.some((r) => r.startsWith(SYN.defaultCorpus))).toBe(false);
    expect(block(noDefault, 'public', 'corpora')!.rows).toHaveLength(2);

    const chapters = parseDump(buildSyntheticDump({ orphanChapter: true }));
    expect(block(chapters, 'public', 'reading_list_chapters')!.rows).toHaveLength(2);
    expect(block(blocks, 'public', 'reading_list_chapters')!.rows).toHaveLength(1);
  });
});

describe('the synthetic dump against the migrated schema', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let sql: Sql;

  beforeAll(async () => {
    scratch = await createScratchDb();
    sql = createSql(scratch.url, { max: 2 });
    await migrate(sql);
    const conn = await sql.reserve();
    try {
      await conn`SET session_replication_role = replica`;
      for (const b of publicBlocks(parseDump(buildSyntheticDump()))) {
        const cols = b.columns.map((c) => `"${c}"`).join(', ');
        const w = await conn.unsafe(`COPY "public"."${b.table}" (${cols}) FROM STDIN`).writable();
        await pipeline(Readable.from(b.rows.map((r) => `${r}\n`)), w);
      }
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('loads every public block (columns exist, values parse)', async () => {
    const count = async (t: string): Promise<number> =>
      Number((await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}"`))[0]!.n);
    expect(await count('users')).toBe(2);
    expect(await count('corpora')).toBe(3);
    expect(await count('papers')).toBe(2);
    expect(await count('chunks')).toBe(3);
    expect(await count('figures')).toBe(1);
    expect(await count('feeds')).toBe(3);
    expect(await count('feed_posts')).toBe(1);
    expect(await count('personas')).toBe(7);
  });

  it('counts its posts and indexes only post 0 of the plain feed', async () => {
    const [r] = await sql`SELECT sum(jsonb_array_length(posts))::int AS n FROM feeds`;
    expect(r!.n).toBe(SYNTHETIC_POST_COUNT);
    expect(SYNTHETIC_POST_COUNT).toBeGreaterThan(1);
    const rows = await sql`SELECT feed_id::text, post_index FROM feed_posts`;
    expect(rows).toEqual([{ feed_id: SYN.feedPlain, post_index: 0 }]);
  });

  it('keeps the archive quirks the cleanup must handle', async () => {
    const [reply] = await sql`SELECT jsonb_typeof(messages) AS t, jsonb_typeof((messages #>> '{}')::jsonb) AS inner FROM post_replies`;
    expect(reply).toEqual({ t: 'string', inner: 'array' });
    const [plain] = await sql`SELECT posts->0 AS p FROM feeds WHERE id = ${SYN.feedPlain}`;
    expect(plain!.p.audio_key).toBe(`${SYN.owner}/feeds/${SYN.feedPlain}/audio/post_0.mp3`);
    expect(plain!.p.figure_url).toMatch(/supabase\.co/);
    const [legacy] = await sql`SELECT podcast_status, podcast_segments->0->>'audio_key' AS k FROM feeds WHERE id = ${SYN.feedLegacyPodcast}`;
    expect(legacy).toEqual({ podcast_status: 'ready', k: `${SYN.owner}/feeds/${SYN.feedLegacyPodcast}/podcast/seg_0.mp3` });
    const [episode] = await sql`
      SELECT podcast_status, bool_or(s ? 'audio_key') AS keyed
      FROM feeds, jsonb_array_elements(podcast_segments) s WHERE id = ${SYN.feedEpisode} GROUP BY podcast_status`;
    expect(episode).toEqual({ podcast_status: 'ready', keyed: false });
    const [paper] = await sql`SELECT file_path FROM papers WHERE id = ${SYN.paperDefault}`;
    expect(paper!.file_path).toBe(`${SYN.owner}/${SYN.paperDefault}.pdf`);
    const [fig] = await sql`SELECT id::text, paper_id::text, image_path FROM figures`;
    expect(fig).toEqual({ id: SYN.figure, paper_id: SYN.paperDefault, image_path: `${SYN.owner}/${SYN.paperDefault}/figures/fig_p1_1.png` });
    const [audit] = await sql`SELECT metadata->>'corpus_id' AS c FROM audit_log WHERE action = 'paper.delete'`;
    expect(audit!.c).toBe(SYN.defaultCorpus);
    const [res] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE resource_type = 'corpus' AND resource_id = ${SYN.defaultCorpus}`;
    expect(res!.n).toBe(1);
    const [chunk] = await sql`SELECT count(*)::int AS n FROM chunks WHERE metadata = '{}'::jsonb AND vector_dims(embedding) = 1024`;
    expect(chunk!.n).toBe(3);
    const stuck = await sql`
      SELECT 'summary' AS k, status FROM paper_summaries
      UNION ALL SELECT 'synthesis', status || ':' || jsonb_array_length(messages) FROM corpus_syntheses
      UNION ALL SELECT 'user_post', status FROM user_posts ORDER BY 1, 2`;
    expect(stuck.map((r) => `${r.k}=${r.status}`)).toEqual([
      'summary=generating', 'synthesis=generating:0', 'synthesis=generating:2', 'user_post=pending',
    ]);
  });

  it('references only seeded persona keys', async () => {
    const [r] = await sql`
      SELECT count(*)::int AS n FROM (
        SELECT persona_key FROM post_replies UNION ALL SELECT persona_key FROM user_likes
      ) k WHERE persona_key IS NOT NULL AND persona_key NOT IN (SELECT key FROM personas)`;
    expect(r!.n).toBe(0);
  });
});
