import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { requireUser } from '../auth/currentUser.js';
import { recordAudit } from '../audit.js';
import { body } from '../http/validate.js';
import { HttpError } from '../http/errors.js';
import {
  NUMERIC_BOUNDS,
  PROVIDER_OVERRIDE_KEYS,
  SECRET_KEYS,
  buildDefaults,
  isPublicDeployment,
  mergeSettings,
  reassertPublicDeployment,
  type Settings,
} from '../settings/schema.js';
import { resolveUserSettings } from '../settings/resolve.js';
import { loadStoredSettings } from '../settings/stored.js';
import type { Sql } from '../db/sql.js';
import { deletePaperArtifacts } from '../storage/local.js';

/** Python int()/float() semantics for a JSON value; throws on failure. */
export function coercePy(kind: 'int' | 'float', v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new TypeError('cannot convert NaN');
    if (kind === 'int') {
      if (!Number.isFinite(v)) throw new TypeError('cannot convert infinity to integer');
      return Math.trunc(v) + 0;
    }
    return v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (kind === 'int') {
      if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new TypeError('invalid literal for int()');
      return Number(s.replace(/_/g, ''));
    }
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
    // "nan" is rejected (Python would store NaN, which jsonb refuses -> 500).
    if (!/^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(s)) {
      throw new TypeError('could not convert string to float');
    }
    return Number(s.replace(/_/g, ''));
  }
  throw new TypeError(`${kind}() argument must be a string or a real number`);
}

const fmtBound = (kind: 'int' | 'float', n: number) => (kind === 'float' && Number.isInteger(n) ? n.toFixed(1) : String(n));

const updateBody = z.object({ settings: z.record(z.string(), z.unknown()) });

function redact(d: Settings): Settings {
  const out: Settings = {};
  for (const [k, v] of Object.entries(d)) out[k] = SECRET_KEYS.has(k) ? (v ? 'set' : '') : v;
  return out;
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function settingsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireUser);

  r.get('/', async (c) => {
    const { sql, env } = c.var.deps;
    return c.json(redact(await resolveUserSettings(sql, c.var.user.id, env)));
  });

  r.put('/', body(updateBody), async (c) => {
    const { sql, env, config, logger } = c.var.deps;
    const defaults = buildDefaults(env);
    const filtered: Record<string, unknown> = {};
    const dropped: string[] = [];
    const locked: string[] = [];
    // Allow-list BEFORE any merge: only own keys of DEFAULTS survive, so __proto__ & co never get through.
    for (const [key, value] of Object.entries(c.req.valid('json').settings)) {
      if (!Object.hasOwn(defaults, key)) {
        dropped.push(key);
        continue;
      }
      if (config.publicDeployment && PROVIDER_OVERRIDE_KEYS.has(key)) {
        locked.push(key);
        continue;
      }
      const bounds = NUMERIC_BOUNDS[key];
      if (bounds) {
        const [kind, lo, hi] = bounds;
        let coerced: number;
        try {
          coerced = coercePy(kind, value);
        } catch {
          throw new HttpError(422, `${key} must be a ${kind}`);
        }
        if (coerced < lo || coerced > hi) {
          throw new HttpError(422, `${key} must be between ${fmtBound(kind, lo)} and ${fmtBound(kind, hi)}`);
        }
        filtered[key] = coerced;
      } else {
        filtered[key] = value;
      }
    }
    if (dropped.length) logger.warn({ keys: dropped, user_id: c.var.user.id }, 'settings_dropped_unknown_keys');
    if (locked.length) {
      logger.warn({ keys: locked, user_id: c.var.user.id }, 'settings_dropped_provider_override_on_public_deployment');
    }

    const existing = await sql.begin(async (tx) => {
      const cur = await loadStoredSettings(tx as unknown as Sql, c.var.user.id, { lock: true });
      for (const [key, value] of Object.entries(filtered)) {
        const base = cur[key];
        cur[key] = isDict(base) && isDict(value) ? { ...base, ...value } : value;
      }
      await tx`
        INSERT INTO user_settings (user_id, settings, updated_at)
        VALUES (${c.var.user.id}, ${tx.json(cur as never)}, NOW())
        ON CONFLICT (user_id) DO UPDATE SET settings = ${tx.json(cur as never)}, updated_at = NOW()`;
      return cur;
    });

    let merged = mergeSettings(defaults, existing);
    if (isPublicDeployment(env)) merged = reassertPublicDeployment(merged, env);
    return c.json(redact(merged));
  });

  r.get('/ollama-models', async (c) => {
    const { config, logger } = c.var.deps;
    const doFetch = c.var.deps.fetch ?? fetch;
    let models: any[];
    try {
      const resp = await doFetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = (await resp.json()) as { models?: any[] };
      models = j.models ?? [];
    } catch (e) {
      logger.warn({ error: String(e) }, 'ollama_models_fetch_failed');
      return c.json({ llm: [], embed: [], vision: [] });
    }
    const llm: unknown[] = [];
    const embed: unknown[] = [];
    const vision: unknown[] = [];
    for (const m of models) {
      const name = String(m.name);
      const sizeGb = Math.round(((m.size ?? 0) / 1e9) * 10) / 10;
      const details = m.details ?? {};
      const info = { name, size: `${sizeGb.toFixed(1)}GB`, family: details.family ?? '' };
      const lower = name.toLowerCase();
      if (lower.includes('embed') || lower.includes('bge') || lower.includes('nomic')) {
        embed.push(info);
      } else {
        llm.push(info);
        const families: unknown[] = Array.isArray(details.families) ? details.families : [];
        if (families.some((f) => String(f).toLowerCase().includes('vision')) || lower.includes('vision')) {
          vision.push(info);
        }
      }
    }
    return c.json({ llm, embed, vision });
  });

  r.post('/clear-feeds', async (c) => {
    await c.var.deps.sql`DELETE FROM feeds WHERE user_id = ${c.var.user.id}`;
    await recordAudit(c, { action: 'feed.clear_all', resourceType: 'feed' });
    return c.json({ status: 'cleared' });
  });

  r.post('/clear-summaries', async (c) => {
    await c.var.deps.sql`
      DELETE FROM paper_summaries WHERE paper_id IN (SELECT id FROM papers WHERE user_id = ${c.var.user.id})`;
    await recordAudit(c, { action: 'summary.clear_all', resourceType: 'paper_summary' });
    return c.json({ status: 'cleared' });
  });

  r.post('/clear-user-posts', async (c) => {
    await c.var.deps.sql`DELETE FROM user_posts WHERE user_id = ${c.var.user.id}`;
    await recordAudit(c, { action: 'user_post.clear_all', resourceType: 'user_post' });
    return c.json({ status: 'cleared' });
  });

  r.post('/clear-everything', async (c) => {
    const { sql, config, logger } = c.var.deps;
    const uid = c.var.user.id;
    const rows = await sql`SELECT id FROM papers WHERE user_id = ${uid}`;
    const paperIds = rows.map((p) => String(p.id));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM alerts           WHERE user_id = ${uid}`;
      await tx`DELETE FROM persona_dms      WHERE user_id = ${uid}`;
      await tx`DELETE FROM user_posts       WHERE user_id = ${uid}`;
      await tx`DELETE FROM corpus_syntheses WHERE user_id = ${uid}`;
      await tx`DELETE FROM reading_lists    WHERE user_id = ${uid}`;
      await tx`DELETE FROM feeds            WHERE user_id = ${uid}`;
      await tx`DELETE FROM papers           WHERE user_id = ${uid}`;
      await tx`DELETE FROM tags             WHERE user_id = ${uid}`;
    });
    for (const id of paperIds) await deletePaperArtifacts(config, id, logger);
    await recordAudit(c, {
      action: 'account.clear_all',
      resourceType: 'account',
      metadata: { paper_count: paperIds.length },
    });
    return c.json({ status: 'cleared', paper_count: paperIds.length });
  });

  r.post('/clear-papers', async (c) => {
    const { sql, config, logger } = c.var.deps;
    const uid = c.var.user.id;
    const rows = await sql`SELECT id FROM papers WHERE user_id = ${uid}`;
    const paperIds = rows.map((p) => String(p.id));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM papers WHERE user_id = ${uid}`;
      await tx`DELETE FROM feeds WHERE user_id = ${uid}`;
    });
    for (const id of paperIds) await deletePaperArtifacts(config, id, logger);
    await recordAudit(c, {
      action: 'paper.clear_all',
      resourceType: 'paper',
      metadata: { paper_count: paperIds.length },
    });
    return c.json({ status: 'cleared', paper_count: paperIds.length });
  });

  return r;
}
