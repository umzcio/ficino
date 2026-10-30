import { describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';

describe('health and discovery', () => {
  it.each(['/health', '/healthz'])('GET %s → ok payload', async (path) => {
    const r = await client(testApp()).get(path);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', service: 'ficino-api' });
  });

  it('GET /auth/provider → {"provider":"none","public_deployment":false}', async () => {
    const r = await client(testApp()).get('/auth/provider');
    expect(await r.json()).toEqual({ provider: 'none', public_deployment: false });
  });

  it('GET /auth/provider reflects config', async () => {
    const app = testApp({ config: { authProvider: 'basic', publicDeployment: true } });
    expect(await (await client(app).get('/auth/provider')).json()).toEqual({
      provider: 'basic',
      public_deployment: true,
    });
  });

  // Replaces api/tests/test_docs_gating.py: no docs are served in this slice, in any environment.
  it('/docs, /redoc and /openapi.json are 404 in every environment', async () => {
    for (const environment of ['development', 'test', 'production']) {
      const c = client(testApp({ config: { environment } }));
      for (const path of ['/docs', '/redoc', '/openapi.json']) {
        expect((await c.get(path)).status, `${path} in ${environment}`).toBe(404);
      }
    }
  });
});
