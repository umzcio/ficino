import { beforeEach, describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';
import { resetDb, testSql } from '../helpers/db.js';

beforeEach(() => resetDb(testSql()));

// Routes that are public on purpose. Everything else must demand a session.
const PUBLIC = new Set([
  // Liveness probes for the container healthcheck / load balancer: no user, no data.
  'GET /health',
  'GET /healthz',
  // The SPA calls this before login to learn which auth UI to render.
  'GET /auth/provider',
  // Registration and login are how a caller obtains a session in the first place.
  'POST /auth/register',
  'POST /auth/login',
]);

const UUID = '123e4567-e89b-42d3-a456-426614174000';

/** `:id` -> a UUID, `:n{[0-9]+}` etc. -> 0. Names that hold integers get 0, the rest a UUID. */
function fill(path: string): string {
  return path.replace(/\*/g, 'feeds/x').replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, name: string) =>
    /(^|_)(index|page|n|seq|position|limit|offset|number)$|_index$|_number$/.test(name) ? '0' : UUID,
  );
}

describe('every route except the public allowlist requires a session', () => {
  const app = testApp({ config: { authProvider: 'basic' } }); // no userOverride, no session cookie
  const routes = app.routes.filter((r) => r.method !== 'ALL');

  // Middleware (app.use / router.use) is registered as ALL on a path ending in '*'. An ALL entry on a
  // concrete path is an app.all() handler that this sweep would skip, so fail instead of ignoring it.
  it('has no ALL handlers outside middleware', () => {
    const stray = app.routes.filter((r) => r.method === 'ALL' && !r.path.endsWith('*'));
    expect(stray.map((r) => r.path)).toEqual([]);
  });

  it('enumerates a non-trivial route table', () => {
    expect(routes.length).toBeGreaterThan(40);
    for (const p of PUBLIC) expect(routes.map((r) => `${r.method} ${r.path}`)).toContain(p);
  });

  const seen = new Set<string>();
  const protectedRoutes = routes.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (PUBLIC.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  it.each(protectedRoutes.map((r) => [`${r.method} ${r.path}`, r.method, r.path]))(
    '%s is 401 without a session',
    async (_label, method, path) => {
      const res = await client(app).send(method, fill(path));
      expect(res.status).toBe(401);
    },
  );

  it('/auth/logout and /auth/me are 401 without a session', async () => {
    const c = client(app);
    expect((await c.post('/auth/logout')).status).toBe(401);
    expect((await c.get('/auth/me')).status).toBe(401);
  });
});

describe('userOverride guard', () => {
  it.each(['production', 'staging'])('createApp throws under ENVIRONMENT=%s', (environment) => {
    expect(() =>
      testApp({
        config: { environment },
        user: { id: '11111111-1111-1111-1111-111111111111', email: 'a@x.dev', display_name: null },
      }),
    ).toThrow('userOverride is only allowed in tests');
  });

  it('is allowed under development and test', () => {
    const user = { id: '11111111-1111-1111-1111-111111111111', email: 'a@x.dev', display_name: null };
    expect(() => testApp({ config: { environment: 'development' }, user })).not.toThrow();
    expect(() => testApp({ config: { environment: 'test' }, user })).not.toThrow();
  });
});
