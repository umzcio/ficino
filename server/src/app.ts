import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { SmartRouter } from 'hono/router/smart-router';
import { TrieRouter } from 'hono/router/trie-router';
import type { Logger } from 'pino';
import type { AuthUser } from './auth/types.js';
import type { Config } from './config.js';
import type { Sql } from './db/sql.js';
import { basicRoutes } from './auth/basicRoutes.js';
import { csrf } from './http/csrf.js';
import { errorHandler } from './http/errors.js';
import { securityHeaders } from './http/securityHeaders.js';
import { alertsRoutes } from './routes/alerts.js';
import { annotationsRoutes } from './routes/annotations.js';
import { bookmarksRoutes } from './routes/bookmarks.js';
import { feedRoutes } from './routes/feed.js';
import { figuresRoutes } from './routes/figures.js';
import { mediaRoutes } from './routes/media.js';
import { papersRoutes } from './routes/papers.js';
import { personasRoutes } from './routes/personas.js';
import { readingListsRoutes } from './routes/readingLists.js';
import { messagesRoutes } from './routes/messages.js';
import { repliesRoutes } from './routes/replies.js';
import { userPostsRoutes } from './routes/userPosts.js';
import { likesRoutes } from './routes/likes.js';
import { healthRoutes } from './routes/health.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';
import { citationsRoutes } from './routes/citations.js';
import { tagsRoutes } from './routes/tags.js';
import { usersRoutes } from './routes/users.js';
import type { JobQueue } from './jobs/queue.js';
import { defaultProviderDeps, type ProviderDeps } from './providers/deps.js';
import type { Rng } from './shared/random.js';
import type { LocalStorage } from './storage/local.js';
import { workspacesRoutes } from './routes/workspaces.js';

export type AppDeps = {
  sql: Sql;
  queue: JobQueue;
  config: Config;
  logger: Logger;
  storage: LocalStorage;
  signingKey: Buffer;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  userOverride?: AuthUser;
  providers?: ProviderDeps;
  rng?: Rng;
};

export type ResolvedAppDeps = AppDeps & { providers: ProviderDeps; rng: Rng };

export type AppEnv = { Variables: { user: AuthUser; deps: ResolvedAppDeps } };

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8000'];

function corsMiddleware(config: Config) {
  if (config.environment === 'development') {
    // No allowHeaders: hono reflects Access-Control-Request-Headers, like Starlette's "*".
    return cors({
      origin: DEV_ORIGINS,
      credentials: true,
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    });
  }
  return cors({
    origin: config.corsOrigins,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'Accept', 'X-CSRF-Token'],
  });
}

/**
 * Methods (other than the request's own) that have a real route matching `path`.
 * Reads `app.routes`, which includes routes mounted via `app.route()`; middleware and
 * `ALL` entries are skipped. The router is rebuilt only when the route table grows.
 */
function makeAllowedMethods(app: Hono<AppEnv>) {
  let built = -1;
  let router = new SmartRouter<true>({ routers: [new RegExpRouter(), new TrieRouter()] });
  let methods: string[] = [];
  return (method: string, path: string): { own: boolean; others: string[] } => {
    if (built !== app.routes.length) {
      router = new SmartRouter<true>({ routers: [new RegExpRouter(), new TrieRouter()] });
      const seen = new Set<string>();
      for (const r of app.routes) {
        if (r.method === 'ALL') continue;
        router.add(r.method, r.path, true);
        seen.add(r.method);
      }
      methods = [...seen];
      built = app.routes.length;
    }
    const matches = (m: string) => router.match(m, path)[0].length > 0;
    const own = method === 'HEAD' ? 'GET' : method;
    return { own: matches(own), others: methods.filter((m) => m !== own && matches(m)) };
  };
}

export function createApp(rawDeps: AppDeps): Hono<AppEnv> {
  const deps: ResolvedAppDeps = {
    ...rawDeps,
    providers: rawDeps.providers ?? defaultProviderDeps(),
    rng: rawDeps.rng ?? Math.random,
  };
  if (deps.userOverride && !['development', 'test'].includes(deps.config.environment)) {
    throw new Error('userOverride is only allowed in tests');
  }
  const app = new Hono<AppEnv>();
  const allowedMethods = makeAllowedMethods(app);

  // Outermost first (C §2.1): CORS wraps CSRF so 403s still carry ACAO; headers are innermost.
  app.use('*', corsMiddleware(deps.config));
  app.use('*', csrf(deps.config));
  app.use('*', securityHeaders(deps.config));
  // Innermost: Hono's compose rethrows non-Error throws past onError (and past the header
  // middleware above), so wrap them here to route them through the normal 500 path.
  app.use('*', async (_c, next) => {
    try {
      await next();
    } catch (e) {
      throw e instanceof Error ? e : new Error(`non-Error thrown: ${String(e)}`);
    }
  });
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });

  app.onError(errorHandler(deps.logger));
  app.notFound((c) => {
    const { own, others } = allowedMethods(c.req.method, c.req.path);
    // A handler called c.notFound() on a real route: that is a 404, not a 405.
    if (!own && others.length > 0) {
      return c.json({ detail: 'Method Not Allowed' }, 405, { Allow: others.join(', ') });
    }
    return c.json({ detail: 'Not Found' }, 404);
  });

  app.route('/', healthRoutes());
  app.get('/auth/provider', (c) =>
    c.json({ provider: deps.config.authProvider, public_deployment: deps.config.publicDeployment }),
  );

  // /auth/login|register|logout|me exist only under the basic provider; otherwise they 404.
  if (deps.config.authProvider === 'basic') app.route('/auth', basicRoutes());

  app.route('/alerts', alertsRoutes());
  app.route('/annotations', annotationsRoutes());
  app.route('/bookmarks', bookmarksRoutes());
  app.route('/feed', feedRoutes());
  app.route('/figures', figuresRoutes());
  app.route('/likes', likesRoutes());
  app.route('/media', mediaRoutes());
  app.route('/papers', papersRoutes());
  app.route('/messages', messagesRoutes());
  app.route('/personas', personasRoutes());
  app.route('/reading-lists', readingListsRoutes());
  app.route('/replies', repliesRoutes());
  app.route('/citations', citationsRoutes());
  app.route('/search', searchRoutes());
  app.route('/settings', settingsRoutes());
  app.route('/tags', tagsRoutes());
  app.route('/user-posts', userPostsRoutes());
  app.route('/users', usersRoutes());
  app.route('/workspaces', workspacesRoutes());

  return app;
}
