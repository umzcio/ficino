import { beforeEach, describe, expect, it } from 'vitest';
import { REGISTER_LOCK_KEY } from '../../src/auth/basicRoutes.js';
import { client, testApp } from '../helpers/client.js';
import { resetDb, testSql } from '../helpers/db.js';

const sql = testSql();
beforeEach(() => resetDb(sql));

const PW = 'correct horse battery';
let ipSeq = 0;

// AUTH_PROVIDER=basic, ALLOW_REGISTRATION=false: only the first account may be created.
function register(email: string, config: { allowRegistration?: boolean } = {}) {
  const app = testApp({ config: { authProvider: 'basic', allowRegistration: false, ...config } });
  // A fresh X-Real-IP per call keeps the per-IP register limit (3/hour) out of the way.
  ipSeq += 1;
  return client(app).post('/auth/register', { email, password: PW }, { headers: { 'x-real-ip': `10.9.0.${ipSeq}` }, peer: '172.18.0.5' });
}

describe('first registration is serialized', () => {
  it('uses its own advisory lock key, not the migration one', () => {
    expect(REGISTER_LOCK_KEY).toBe(727275);
  });

  it('two simultaneous first registrations create one account', async () => {
    const [a, b] = await Promise.all([register('a@example.com'), register('b@example.com')]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    const loser = a.status === 403 ? a : b;
    expect(await loser.json()).toEqual({ detail: 'Registration is disabled' });
    expect((await sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM corpora`)[0].n).toBe(1);
  });

  it('five simultaneous first registrations still create one account', async () => {
    const rs = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => register(`${n}@example.com`)));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 403, 403, 403, 403]);
    expect((await sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(1);
  });

  it('two simultaneous registrations of one email: one 201, one 409, one user', async () => {
    const [a, b] = await Promise.all([
      register('same@example.com', { allowRegistration: true }),
      register('same@example.com', { allowRegistration: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await loser.json()).toEqual({ detail: 'Email already registered' });
    expect((await sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(1);
  });

  it('waits for a holder of the register lock, then proceeds', async () => {
    const holder = await sql.reserve();
    try {
      await holder`SELECT pg_advisory_lock(${REGISTER_LOCK_KEY})`;
      let settled = false;
      const pending = register('a@example.com').finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      expect((await sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(0);
      await holder`SELECT pg_advisory_unlock(${REGISTER_LOCK_KEY})`;
      expect((await pending).status).toBe(201);
    } finally {
      await holder`SELECT pg_advisory_unlock_all()`;
      holder.release();
    }
  });
});
