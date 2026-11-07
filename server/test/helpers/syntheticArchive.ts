// Synthetic stand-in for the archived SaaS data: a pg_dump-shaped text with the same quirks as the real archive
// (auth/storage schemas, user-prefixed storage keys, stale signed URLs, a drifted feed_posts index, a legacy stitched
// podcast, double-encoded jsonb, stuck task rows, ids inside audit_log). Every id, name and value here is invented;
// restore tests use only this, never real data.

/** Fixed ids so tests can name rows. Distinct first groups keep each kind recognisable in a failure message. */
export const SYN = {
  owner: '5a000000-0000-4000-8000-000000000001',
  orphan: '5a000000-0000-4000-8000-000000000002',
  defaultCorpus: '5c000000-0000-4000-8000-000000000001',
  otherCorpus: '5c000000-0000-4000-8000-000000000002',
  orphanCorpus: '5c000000-0000-4000-8000-000000000003',
  paperDefault: '5d000000-0000-4000-8000-000000000001',
  paperOther: '5d000000-0000-4000-8000-000000000002',
  /** Only with `secondOwner`: the orphan's paper. */
  paperOrphan: '5d000000-0000-4000-8000-000000000003',
  feedPlain: '5f000000-0000-4000-8000-000000000001',
  feedLegacyPodcast: '5f000000-0000-4000-8000-000000000002',
  feedEpisode: '5f000000-0000-4000-8000-000000000003',
  figure: '5e000000-0000-4000-8000-000000000001',
  summary: '5b000000-0000-4000-8000-000000000001',
  synthesisWithMessages: '59000000-0000-4000-8000-000000000001',
  synthesisEmpty: '59000000-0000-4000-8000-000000000002',
  userPost: '58000000-0000-4000-8000-000000000001',
  readingList: '57000000-0000-4000-8000-000000000001',
} as const;

/** Appears only in the auth blocks (password hash, refresh token): a restore must never load or print it. */
export const SECRET_MARKER = 'SYNTHETIC-SECRET-MARKER';

/** Ids of rows no test names directly. */
const ROW = (n: number): string => `50000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AUTH_OWNER = '5a5a0000-0000-4000-8000-000000000001';
const AUTH_ORPHAN = '5a5a0000-0000-4000-8000-000000000002';

const T0 = '2026-01-05 10:00:00+00';
const T1 = '2026-01-05 11:30:00+00';

// ---------------------------------------------------------------------------------------------------------------
// COPY text format

/** A jsonb value: always JSON-encoded, even when it is an array or a string. */
class Json {
  constructor(readonly value: unknown) {}
}
const json = (value: unknown): Json => new Json(value);

type Value = string | number | boolean | null | readonly (string | null)[] | Json | Record<string, unknown>;

/** One element of a Postgres array literal, quoted when it has to be. */
function arrayElement(v: string | null): string {
  if (v === null) return 'NULL';
  if (v === '' || /[{},"\\\s]/.test(v) || v.toUpperCase() === 'NULL') return `"${v.replace(/[\\"]/g, '\\$&')}"`;
  return v;
}

/**
 * One field in COPY text format: `\N` for null; backslash, tab, newline and carriage return escaped; arrays as a
 * Postgres array literal; plain objects and `json(…)` values as JSON (for jsonb columns).
 */
export function copyText(v: Value): string {
  let s: string;
  if (v === null) return '\\N';
  if (typeof v === 'boolean') s = v ? 't' : 'f';
  else if (typeof v === 'number') s = String(v);
  else if (typeof v === 'string') s = v;
  else if (v instanceof Json) s = JSON.stringify(v.value);
  else if (Array.isArray(v)) s = `{${v.map(arrayElement).join(',')}}`;
  else s = JSON.stringify(v);
  return s.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[c]!);
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

type Table = { schema: string; table: string; columns: string[]; rows: Record<string, Value>[] };

function copyBlock(t: Table): string {
  const lines = t.rows.map((row) =>
    t.columns
      .map((c) => {
        if (!Object.hasOwn(row, c)) throw new Error(`synthetic ${t.schema}.${t.table} row has no ${c}`);
        return copyText(row[c]!);
      })
      .join('\t'),
  );
  return [
    '--',
    `-- Data for Name: ${t.table}; Type: TABLE DATA; Schema: ${t.schema}; Owner: -`,
    '--',
    '',
    `COPY ${quoteIdent(t.schema)}.${quoteIdent(t.table)} (${t.columns.map(quoteIdent).join(', ')}) FROM stdin;`,
    ...lines,
    '\\.',
    '',
    '',
  ].join('\n');
}

const vector = (hot: number): string => `[${Array.from({ length: 1024 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;

// ---------------------------------------------------------------------------------------------------------------
// Rows

const figureUrl = `https://x.supabase.co/storage/v1/object/sign/papers/${SYN.owner}/${SYN.paperDefault}/figures/fig_p1_1.png?token=synthetic`;

function plainPosts(): Record<string, unknown>[] {
  return [
    {
      id: 1,
      persona: 'skeptic',
      post_type: 'post',
      category: 'methods',
      content: 'Synthetic post zero: the sample is small.',
      paper_ref: 'Author 2024',
      paper_id: SYN.paperDefault,
      figure_id: SYN.figure,
      figure_url: figureUrl,
      audio_key: `${SYN.owner}/feeds/${SYN.feedPlain}/audio/post_0.mp3`,
    },
    {
      id: 2,
      persona: 'hype',
      post_type: 'post',
      category: 'findings',
      content: 'Synthetic post one, with a "quote",\ta tab and a backslash \\ inside.',
      paper_ref: 'Author 2024',
      paper_id: SYN.paperDefault,
    },
  ];
}

const simplePosts = (feed: string): Record<string, unknown>[] =>
  [0, 1].map((i) => ({
    id: i + 1,
    persona: i === 0 ? 'practitioner' : 'gradstudent',
    post_type: 'post',
    category: 'context',
    content: `Synthetic post ${i} of feed ${feed.slice(-1)}.`,
    paper_ref: 'Author 2024',
    paper_id: SYN.paperDefault,
  }));

type FeedSpec = { id: string; posts: Record<string, unknown>[]; audio: boolean; podcast: Record<string, unknown>[] | null };

function feedSpecs(): FeedSpec[] {
  return [
    { id: SYN.feedPlain, posts: plainPosts(), audio: true, podcast: null },
    {
      id: SYN.feedLegacyPodcast,
      posts: simplePosts(SYN.feedLegacyPodcast),
      audio: false,
      podcast: [
        {
          speaker: 'host_a',
          text: 'A legacy stitched segment.',
          audio_key: `${SYN.owner}/feeds/${SYN.feedLegacyPodcast}/podcast/seg_0.mp3`,
        },
      ],
    },
    {
      id: SYN.feedEpisode,
      posts: simplePosts(SYN.feedEpisode),
      audio: false,
      podcast: [
        { speaker: 'host_a', text: 'A single-episode podcast.' },
        { speaker: 'host_b', text: 'With no per-segment audio.' },
      ],
    },
  ];
}

/** `sum(jsonb_array_length(posts))` over the synthetic feeds. */
export const SYNTHETIC_POST_COUNT = feedSpecs().reduce((n, f) => n + f.posts.length, 0);

export type SyntheticDumpOptions = {
  /** The orphan user also owns a paper, so there are two candidate owners. */
  secondOwner?: boolean;
  /** The users block carries a column (`legacy_col`) the TS schema lacks. */
  extraColumn?: boolean;
  /** The owner has no corpus named `Default`. */
  omitDefaultCorpus?: boolean;
  /** A second reading_list_chapters row whose reading_list_id matches no reading list. */
  orphanChapter?: boolean;
};

function tables(o: SyntheticDumpOptions): Table[] {
  const feeds = feedSpecs();
  const papers: Record<string, Value>[] = [
    paperRow(SYN.paperDefault, SYN.owner, SYN.defaultCorpus, 'Synthetic Paper One', 'synthetic-one.pdf', 2, 1),
    paperRow(SYN.paperOther, SYN.owner, SYN.otherCorpus, 'Synthetic Paper Two', 'synthetic-two.pdf', 1, 0),
  ];
  if (o.secondOwner) {
    papers.push(paperRow(SYN.paperOrphan, SYN.orphan, SYN.orphanCorpus, 'Synthetic Paper Three', 'synthetic-three.pdf', 0, 0));
  }
  const corpora: Record<string, Value>[] = [
    { id: SYN.defaultCorpus, user_id: SYN.owner, name: 'Default', created_at: T0 },
    { id: SYN.otherCorpus, user_id: SYN.owner, name: 'Other', created_at: T0 },
    { id: SYN.orphanCorpus, user_id: SYN.orphan, name: 'Default', created_at: T0 },
  ].filter((c) => !(o.omitDefaultCorpus && c.id === SYN.defaultCorpus));
  const chapters: Record<string, Value>[] = [
    {
      id: ROW(0x40),
      reading_list_id: SYN.readingList,
      chapter_index: 0,
      paper_ids: [SYN.paperDefault],
      feed_id: SYN.feedEpisode,
      status: 'complete',
      created_at: T0,
    },
  ];
  if (o.orphanChapter) {
    chapters.push({
      id: ROW(0x41),
      reading_list_id: ROW(0xdead),
      chapter_index: 0,
      paper_ids: [SYN.paperOther],
      feed_id: null,
      status: 'locked',
      created_at: T0,
    });
  }
  const userColumns = ['id', 'clerk_id', 'email', 'password_hash', 'display_name', 'created_at',
    'generation_count_today', 'generation_reset_at'];
  const users: Record<string, Value>[] = [
    { id: SYN.owner, clerk_id: AUTH_OWNER, email: 'owner@example.com', password_hash: null, display_name: null,
      created_at: T0, generation_count_today: 0, generation_reset_at: T0, legacy_col: 'legacy-a' },
    { id: SYN.orphan, clerk_id: AUTH_ORPHAN, email: 'orphan@example.com', password_hash: null, display_name: null,
      created_at: T0, generation_count_today: 0, generation_reset_at: T0, legacy_col: 'legacy-b' },
  ];

  return [
    {
      schema: 'auth',
      table: 'users',
      columns: ['instance_id', 'id', 'aud', 'role', 'email', 'encrypted_password', 'email_confirmed_at', 'created_at'],
      rows: [{ instance_id: '00000000-0000-0000-0000-000000000000', id: AUTH_OWNER, aud: 'authenticated',
        role: 'authenticated', email: 'owner@example.com', encrypted_password: `$2a$10$${SECRET_MARKER}`,
        email_confirmed_at: T0, created_at: T0 }],
    },
    {
      schema: 'auth',
      table: 'refresh_tokens',
      columns: ['instance_id', 'id', 'token', 'user_id', 'revoked', 'created_at', 'updated_at', 'parent', 'session_id'],
      rows: [{ instance_id: '00000000-0000-0000-0000-000000000000', id: 1, token: `${SECRET_MARKER}-refresh`,
        user_id: AUTH_OWNER, revoked: false, created_at: T0, updated_at: T0, parent: null, session_id: ROW(0x90) }],
    },
    {
      schema: 'public',
      table: 'users',
      columns: o.extraColumn ? [...userColumns, 'legacy_col'] : userColumns,
      rows: users,
    },
    { schema: 'public', table: 'corpora', columns: ['id', 'user_id', 'name', 'created_at'], rows: corpora },
    {
      schema: 'public',
      table: 'papers',
      columns: ['id', 'user_id', 'corpus_id', 'title', 'authors', 'year', 'doi', 'filename', 'file_path', 'status',
        'extraction_path', 'error_message', 'chunk_count', 'figure_count', 'uploaded_at', 'processed_at'],
      rows: papers,
    },
    {
      schema: 'public',
      table: 'chunks',
      columns: ['id', 'paper_id', 'user_id', 'section', 'content', 'chunk_type', 'chunk_index', 'token_count',
        'embedding', 'search_vector', 'contextual_prefix', 'metadata'],
      rows: [
        chunkRow(ROW(0x10), SYN.paperDefault, 0, 'First synthetic chunk.\nSecond line\twith a tab and a backslash \\.'),
        chunkRow(ROW(0x11), SYN.paperDefault, 1, 'Second synthetic chunk.'),
        chunkRow(ROW(0x12), SYN.paperOther, 0, 'Only chunk of the other paper.'),
      ],
    },
    {
      // A subset of the baseline columns, not in baseline order (figure_index moved up; bbox and
      // referenced_paragraph absent): a real dump's column order follows the source table, not ours.
      schema: 'public',
      table: 'figures',
      columns: ['id', 'paper_id', 'figure_index', 'page_number', 'image_path', 'extraction_type', 'description',
        'claim_summary', 'processed_at', 'figure_type', 'caption', 'figure_number', 'data_claim', 'detector_confidence'],
      rows: [{
        id: SYN.figure, paper_id: SYN.paperDefault, figure_index: 0, page_number: 1,
        image_path: `${SYN.owner}/${SYN.paperDefault}/figures/fig_p1_1.png`, extraction_type: 'embedded',
        description: 'A synthetic bar chart.', claim_summary: 'Bars go up.', processed_at: T0, figure_type: 'chart_bar',
        caption: 'Figure 1: synthetic.', figure_number: '1', data_claim: null, detector_confidence: 0.9,
      }],
    },
    {
      schema: 'public',
      table: 'feeds',
      columns: ['id', 'user_id', 'corpus_id', 'tag_filter', 'posts', 'generated_at', 'generation_duration_ms',
        'paper_count', 'post_count', 'audio_status', 'audio_generated_at', 'audio_claimed_at', 'podcast_claimed_at',
        'podcast_status', 'podcast_generated_at', 'podcast_segments'],
      rows: feeds.map((f) => ({
        id: f.id, user_id: SYN.owner, corpus_id: SYN.defaultCorpus, tag_filter: null, posts: json(f.posts),
        generated_at: T0, generation_duration_ms: 1234, paper_count: 1, post_count: f.posts.length,
        audio_status: f.audio ? 'ready' : null, audio_generated_at: f.audio ? T1 : null, audio_claimed_at: f.audio ? T1 : null,
        podcast_claimed_at: f.podcast ? T1 : null, podcast_status: f.podcast ? 'ready' : null,
        podcast_generated_at: f.podcast ? T1 : null, podcast_segments: f.podcast ? json(f.podcast) : null,
      })),
    },
    {
      // Drift: the archive's index lags feeds.posts; only post 0 of feedPlain is indexed, with its stale URL.
      schema: 'public',
      table: 'feed_posts',
      columns: ['id', 'feed_id', 'user_id', 'post_index', 'content_text', 'persona', 'post_type', 'category',
        'paper_ref', 'data', 'deleted', 'created_at'],
      rows: [{
        id: ROW(0x20), feed_id: SYN.feedPlain, user_id: SYN.owner, post_index: 0,
        content_text: String(plainPosts()[0]!.content), persona: 'skeptic', post_type: 'post', category: 'methods',
        paper_ref: 'Author 2024', data: json(plainPosts()[0]), deleted: false, created_at: T0,
      }],
    },
    {
      schema: 'public',
      table: 'personas',
      columns: ['key', 'handle', 'name', 'initials', 'color', 'retrieval_query', 'system_prompt', 'avatar_url', 'bio',
        'is_active', 'feed_eligible', 'sort_order', 'allowed_figure_types', 'created_at', 'updated_at', 'temperature'],
      rows: [{
        key: 'skeptic', handle: '@synthetic', name: 'Synthetic Persona', initials: 'SP', color: '#000000',
        retrieval_query: 'methods', system_prompt: 'A synthetic prompt.', avatar_url: '/personas/x.png', bio: null,
        is_active: true, feed_eligible: true, sort_order: 0, allowed_figure_types: ['chart_bar'], created_at: T0,
        updated_at: T0, temperature: 0.6,
      }],
    },
    {
      schema: 'public',
      table: 'paper_summaries',
      columns: ['id', 'paper_id', 'messages', 'status', 'task_id', 'generated_at'],
      rows: [{ id: SYN.summary, paper_id: SYN.paperDefault, messages: json([]), status: 'generating',
        task_id: ROW(0x70), generated_at: T0 }],
    },
    {
      schema: 'public',
      table: 'corpus_syntheses',
      columns: ['id', 'user_id', 'name', 'paper_ids', 'messages', 'generated_at', 'status', 'task_id'],
      rows: [
        { id: SYN.synthesisWithMessages, user_id: SYN.owner, name: 'Synthetic synthesis',
          paper_ids: [SYN.paperDefault, SYN.paperOther],
          messages: json([
            { persona: 'skeptic', content: 'Synthetic synthesis message one.' },
            { persona: 'hype', content: 'Synthetic synthesis message two.' },
          ]),
          generated_at: T0, status: 'generating', task_id: ROW(0x71) },
        { id: SYN.synthesisEmpty, user_id: SYN.owner, name: 'Empty synthesis', paper_ids: [SYN.paperDefault],
          messages: json([]), generated_at: T0, status: 'generating', task_id: ROW(0x72) },
      ],
    },
    {
      schema: 'public',
      table: 'user_posts',
      columns: ['id', 'user_id', 'corpus_id', 'content', 'replies', 'sources', 'status', 'task_id', 'created_at'],
      rows: [{ id: SYN.userPost, user_id: SYN.owner, corpus_id: SYN.defaultCorpus, content: 'A synthetic user post.',
        replies: json([]), sources: json([]), status: 'pending', task_id: ROW(0x73), created_at: T0 }],
    },
    {
      // messages double-encoded: the jsonb value is a JSON *string* holding the array.
      schema: 'public',
      table: 'post_replies',
      columns: ['id', 'feed_id', 'post_index', 'persona_key', 'messages', 'created_at', 'updated_at'],
      rows: [{ id: ROW(0x30), feed_id: SYN.feedPlain, post_index: 0, persona_key: 'skeptic',
        messages: json(JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'persona', content: 'Hello.' }])),
        created_at: T0, updated_at: T0 }],
    },
    {
      schema: 'public',
      table: 'user_settings',
      columns: ['user_id', 'settings', 'updated_at'],
      rows: [{ user_id: SYN.owner, settings: { preferences: { liked_personas: { skeptic: 1 } } }, updated_at: T0 }],
    },
    { schema: 'public', table: 'tags', columns: ['id', 'user_id', 'name'],
      rows: [{ id: ROW(0x50), user_id: SYN.owner, name: 'synthetic' }] },
    { schema: 'public', table: 'paper_tags', columns: ['paper_id', 'tag_id'],
      rows: [{ paper_id: SYN.paperDefault, tag_id: ROW(0x50) }] },
    {
      schema: 'public',
      table: 'reading_lists',
      columns: ['id', 'user_id', 'corpus_id', 'name', 'paper_sequence', 'rationale', 'created_at'],
      rows: [{ id: SYN.readingList, user_id: SYN.owner, corpus_id: SYN.defaultCorpus, name: 'Synthetic list',
        paper_sequence: [SYN.paperDefault, SYN.paperOther],
        rationale: json([{ paper_id: SYN.paperDefault, reason: 'Start here.' }]), created_at: T0 }],
    },
    {
      schema: 'public',
      table: 'reading_list_chapters',
      columns: ['id', 'reading_list_id', 'chapter_index', 'paper_ids', 'feed_id', 'status', 'created_at'],
      rows: chapters,
    },
    {
      schema: 'public',
      table: 'alerts',
      columns: ['id', 'user_id', 'alert_type', 'title', 'body', 'metadata', 'read', 'dismissed', 'dedupe_hash',
        'created_at'],
      rows: [{ id: ROW(0x60), user_id: SYN.owner, alert_type: 'gap', title: 'A synthetic alert',
        body: 'Synthetic body.', metadata: { paper_id: SYN.paperDefault }, read: false, dismissed: false,
        dedupe_hash: 'synthetic-hash', created_at: T0 }],
    },
    {
      // Ids outside id columns: metadata.corpus_id and resource_id both name the source Default corpus.
      schema: 'public',
      table: 'audit_log',
      columns: ['id', 'user_id', 'action', 'resource_type', 'resource_id', 'metadata', 'ip', 'user_agent',
        'status_code', 'created_at'],
      rows: [
        { id: ROW(0x80), user_id: SYN.owner, action: 'paper.delete', resource_type: 'paper', resource_id: ROW(0x81),
          metadata: { filename: 'synthetic-deleted.pdf', corpus_id: SYN.defaultCorpus }, ip: '203.0.113.7',
          user_agent: 'synthetic-agent/1.0', status_code: 200, created_at: T0 },
        { id: ROW(0x82), user_id: SYN.owner, action: 'corpus.rename', resource_type: 'corpus',
          resource_id: SYN.defaultCorpus, metadata: { name: 'Default' }, ip: '203.0.113.7',
          user_agent: 'synthetic-agent/1.0', status_code: 200, created_at: T1 },
      ],
    },
    {
      schema: 'public',
      table: 'user_likes',
      columns: ['id', 'user_id', 'feed_id', 'post_index', 'message_index', 'persona_key', 'post_type', 'category',
        'liked_at'],
      rows: [{ id: ROW(0x31), user_id: SYN.owner, feed_id: SYN.feedPlain, post_index: 1, message_index: -1,
        persona_key: 'hype', post_type: 'post', category: 'findings', liked_at: T1 }],
    },
    {
      schema: 'storage',
      table: 'objects',
      columns: ['id', 'bucket_id', 'name', 'owner', 'created_at', 'metadata'],
      rows: [{ id: ROW(0xa0), bucket_id: 'papers', name: `${SYN.owner}/${SYN.paperDefault}.pdf`, owner: AUTH_OWNER,
        created_at: T0, metadata: { eTag: '"00000000000000000000000000000000"', size: 1, mimetype: 'application/pdf' } }],
    },
  ];
}

function paperRow(id: string, user: string, corpus: string, title: string, filename: string, chunks: number,
  figures: number): Record<string, Value> {
  return {
    id, user_id: user, corpus_id: corpus, title, authors: ['A. Author', 'B. Author'], year: 2024, doi: null, filename,
    file_path: `${user}/${id}.pdf`, status: 'complete', extraction_path: null, error_message: null,
    chunk_count: chunks, figure_count: figures, uploaded_at: T0, processed_at: T1,
  };
}

function chunkRow(id: string, paper: string, index: number, content: string): Record<string, Value> {
  return {
    id, paper_id: paper, user_id: SYN.owner, section: 'body', content, chunk_type: 'text', chunk_index: index,
    token_count: 12, embedding: vector(index), search_vector: "'chunk':2 'synthet':1", contextual_prefix: null,
    metadata: {},
  };
}

/**
 * A plain-text pg_dump of the synthetic archive: `\restrict`/`\unrestrict`, the usual SET preamble (with
 * `session_replication_role = replica`), auth, public and storage COPY blocks, and a trailing setval.
 */
export function buildSyntheticDump(opts: SyntheticDumpOptions = {}): string {
  const head = [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    '\\restrict SyntheticRestrictKey0000000000000000000000000000000000000000000',
    '',
    '-- Dumped from database version 17.6',
    '-- Dumped by pg_dump version 17.6',
    '',
    'SET statement_timeout = 0;',
    'SET lock_timeout = 0;',
    'SET idle_in_transaction_session_timeout = 0;',
    'SET transaction_timeout = 0;',
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    'SET check_function_bodies = false;',
    'SET xmloption = content;',
    'SET client_min_messages = warning;',
    'SET row_security = off;',
    'SET session_replication_role = replica;',
    '',
    '',
  ].join('\n');
  const tail = [
    '--',
    '-- Name: refresh_tokens_id_seq; Type: SEQUENCE SET; Schema: auth; Owner: -',
    '--',
    '',
    `SELECT pg_catalog.setval('"auth"."refresh_tokens_id_seq"', 1, true);`,
    '',
    '--',
    '-- PostgreSQL database dump complete',
    '--',
    '',
    '\\unrestrict SyntheticRestrictKey0000000000000000000000000000000000000000000',
    '',
    'RESET ALL;',
    '',
  ].join('\n');
  return head + tables(opts).map(copyBlock).join('') + tail;
}
