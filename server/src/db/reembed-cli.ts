// Re-embed one user's chunks with the embedding model their settings resolve to.
//   node dist/db/reembed-cli.js [--user <uuid>]      (default: the stub user)
// stdout carries exactly one JSON line, { target, before, after, updated }; logs and errors go to stderr.
// Exit 0 when no chunk is left on another model, 1 otherwise or on any error.
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { loadJobSettings } from '../providers/config.js';
import { defaultProviderDeps } from '../providers/deps.js';
import { STUB_USER_ID } from '../shared/constants.js';
import { isUuid } from '../shared/uuid.js';
import { embedModelCounts, reembedUserChunks } from '../tasks/reembed.js';
import { createSql } from './sql.js';

// src/logger.ts writes to stdout, which is reserved for the result line: everything here logs through this one.
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { user: { type: 'string' } }, strict: true, allowPositionals: false });
  const userId = values.user ?? STUB_USER_ID;
  if (!isUuid(userId)) throw new Error(`--user must be a uuid, got ${JSON.stringify(userId)}`);

  const config = loadConfig(process.env, log);
  const sql = createSql(config.databaseUrl, { max: 2 });
  // The first SIGINT/SIGTERM stops after the batch in flight (its write is discarded); a second one kills.
  const ac = new AbortController();
  const stop = () => ac.abort(new Error('interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { providers } = await loadJobSettings(sql, userId, process.env, config);
    const before = await embedModelCounts(sql, userId);
    const result = await reembedUserChunks(sql, providers, defaultProviderDeps(), { userId, signal: ac.signal, log });
    const after = await embedModelCounts(sql, userId);
    process.stdout.write(`${JSON.stringify({ target: result.target, before, after, updated: result.updated })}\n`);
    if (result.remaining > 0) log.error({ remaining: result.remaining, target: result.target }, 'reembed_incomplete');
    return result.remaining === 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await sql.end();
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`reembed failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
