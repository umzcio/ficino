import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createApp } from '../app.js';
import { ensureStubUser } from '../auth/bootstrap.js';
import { loadConfig, type Env } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createSql } from '../db/sql.js';
import { logger } from '../logger.js';
import { resolveSigningKey } from '../shared/signedUrl.js';
import { LocalStorage } from '../storage/local.js';

export interface RunningApi {
  close(): Promise<void>;
  port: number;
  host: string;
}

/** Boots the API: config, pool, migrations, stub user (AUTH_PROVIDER=none), then the HTTP listener. */
export async function startApi(env: Env = process.env): Promise<RunningApi> {
  const config = loadConfig(env);
  const sql = createSql(config.databaseUrl, { max: config.dbPoolMax });
  let app: ReturnType<typeof createApp>;
  try {
    const signingKey = resolveSigningKey(env);
    const storage = new LocalStorage(config, signingKey, logger);
    await migrate(sql);
    if (config.authProvider === 'none') await ensureStubUser(sql);
    app = createApp({ sql, config, logger, storage, signingKey, env });
  } catch (e) {
    await sql.end();
    throw e;
  }
  const hostname = env.API_HOST || '127.0.0.1';
  // Plain HTTP/1 server (no createServer/tls options), so the union type narrows safely.
  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname }, () => resolve(s)) as Server;
    s.once('error', reject);
  }).catch(async (e) => {
    await sql.end();
    throw e;
  });
  const { port, address } = server.address() as AddressInfo;
  logger.info({ port, host: hostname }, 'ficino api listening');

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await sql.end();
    })());
  return { close, port, host: address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApi()
    .then((api) => {
      const stop = () => {
        api.close().then(
          () => process.exit(0),
          (e) => {
            logger.error({ err: e }, 'shutdown failed');
            process.exit(1);
          },
        );
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((e) => {
      logger.error({ err: e }, 'startup failed');
      process.exit(1);
    });
}
