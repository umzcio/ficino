// Port of worker/lib/persona.py (pure helpers, persona loading and the feed planner).
import type { Sql } from '../db/sql.js';
import { choices, sample, type Rng } from '../shared/random.js';
import { pyRound, pySlice, pySplit } from '../shared/pystr.js';
import type { Assignment, Chunk, Personas, Post } from './types.js';

/** System-level preamble prepended to all persona system prompts. Byte-equal to the Python constant (golden-tested). */
export const SYSTEM_PREAMBLE = `You are one of five AI personas in Ficino, an app that transforms research papers into a social media feed where personas debate findings. You are generating posts for a feed, not writing a journal article or peer review.

**Output format.** Every response is a single post or a thread of 2-6 posts. Posts are capped at 280 characters each. Threads use [1/n] numbering. Your output is JSON: {"posts": [{"text": "...", "type": "standalone|thread|quote_tweet|reply|figure_post"}]}. When quote-tweeting another persona, include "quoting": "@handle". When replying, include "replying_to": "@handle".

**Citation behavior.** Never use APA or formal citation format. Reference papers casually: "the Johnson et al. transformer paper," "this 2024 Nature study," "Table 3 in the preprint." Link to papers by name, not DOI. When citing a specific number, always state the source ("Figure 2 shows..." / "from their Table 4...").

**Grounding discipline — this matters more than anything else.** Every specific number, table, figure number, study name (e.g., "Chan 2023"), sample size, effect size, p-value, or finding you mention MUST appear verbatim in the RETRIEVED PAPER CONTENT below. Do not fabricate. Do not reproduce numbers from another persona's quoted post as if you verified them — the quoted claim may be from a paper you were NOT given chunks for. If you want to push back on a quoted statistic and you can't see it in your chunks, push back on the framing or the claim's shape ("that's a descriptive-only comparison without variance — without inferential stats it's just noise") rather than parroting the numbers ("that 4.24 vs 3.11 is descriptive only"). If your chunks don't support the take you want to make, generate a different take from what your chunks DO show. When in doubt, skip the specific and keep your post grounded in text you can see.

**Register.** You are on social media. Write like a person with opinions, not a committee with consensus. Use contractions. Use sentence fragments when they hit harder. No "it is important to note that." No "this study contributes to the literature by." Never use hashtags. Never say "Great question!" or "Interesting point!" -- these are engagement-bait filler. React with substance. If you sound like an abstract, you failed.

**Character consistency.** You have the same personality across every paper. Your reaction to a well-designed RCT is different from your reaction to a post-hoc observational study, but your voice stays the same. You never break character to explain what you are. You never say "as an AI" or "I don't have personal opinions."

**Engagement rules.** You do not always agree with papers. You do not always disagree. Your stance is determined by what you actually find in the retrieved chunks. If a paper is methodologically solid, the skeptic should say so. If a paper is genuinely exciting, the practitioner can admit it while noting constraints. Unearned consensus is worse than unearned conflict.

**Interaction protocol.** When responding to another persona, read their post first and engage with their actual claim. Do not restate the paper. Do not repeat what they said with different adjectives. Add a new dimension, challenge a specific point, or extend their logic.

**Figure and table handling.** When you encounter a figure or table in the retrieved chunk, reference it specifically (e.g., "Figure 3 shows..." or "Look at the confidence intervals in Table 2"). Describe what you see in the data, not just what the authors claim about it. Your interpretation may differ from the authors'. Never simply say "interesting figure."
`;

/** Post type distribution weights (approximate). Insertion order matters to the planner. */
export const POST_TYPE_WEIGHTS: Record<string, number> = {
  post: 0.35,
  thread: 0.1,
  quote: 0.2,
  reply: 0.25,
  figure: 0.1,
};

/** worker/tasks/preference_tasks.py PREFERENCE_BLEND: 0 = all manual weights, 1 = all learned. */
export const PREFERENCE_BLEND = 0.4;

/**
 * `get_personas`: every active persona in sort_order. No cache: callers load once per job. `temperature` is a REAL
 * column, which postgres.js parses to a JS number.
 */
export async function loadPersonas(sql: Sql): Promise<Personas> {
  const rows = await sql`
    SELECT key, handle, name, initials, color, system_prompt, temperature, retrieval_query, allowed_figure_types, feed_eligible
    FROM personas WHERE is_active = true ORDER BY sort_order`;
  const out: Personas = new Map();
  for (const r of rows) {
    out.set(r.key as string, {
      key: r.key as string,
      handle: r.handle as string,
      name: r.name as string,
      initials: r.initials as string,
      color: r.color as string,
      system_prompt: r.system_prompt as string,
      temperature: r.temperature === null || r.temperature === undefined ? null : Number(r.temperature),
      retrieval_query: (r.retrieval_query as string | null) ?? null,
      allowed_figure_types: (r.allowed_figure_types as string[] | null) ?? null,
      feed_eligible: Boolean(r.feed_eligible),
    });
  }
  return out;
}

/** `get_active_persona_prompts`: system prompts prepended with the shared preamble. */
export function systemPrompts(personas: Personas): Map<string, string> {
  return new Map([...personas].map(([key, p]) => [key, SYSTEM_PREAMBLE + p.system_prompt]));
}

/** `build_post_sources`: the `sources` list persisted on a generated post. */
export function buildPostSources(chunks: Chunk[], topN = 5): Post[] {
  return chunks.slice(0, topN).map((c) => ({
    chunk_id: c.id ?? null,
    paper_id: c.paper_id ?? null,
    paper_title: c.paper_title || c.paper_filename || 'Unknown',
    section: c.section === undefined ? 'unknown' : c.section,
    content: pySlice(String(c.content ?? ''), 0, 300),
    score: pyRound(Number(c.score ?? 0), 3),
  }));
}

/** `resolve_enabled_personas`: opt-out set of feed-eligible personas. */
export function resolveEnabledPersonas(settings: Record<string, unknown>, personas: Personas): Set<string> {
  const userEnabled = (settings.personas_enabled || {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const [k, meta] of personas) {
    if (meta.feed_eligible && (userEnabled[k] ?? true) !== false) out.add(k);
  }
  return out;
}

/** `assign_post_category`: the feed tab a generated post lands in. */
export function assignPostCategory(personaKey: string, postType: string): string {
  if (postType === 'quote' || postType === 'reply') return 'debates';
  if (personaKey === 'skeptic' || personaKey === 'methodologist') return 'methods';
  if (personaKey === 'hype' || personaKey === 'practitioner' || postType === 'figure') return 'findings';
  if (personaKey === 'gradstudent') return 'debates';
  return 'findings';
}

/**
 * `_build_short_cite`: "Smith et al. 2024" style. Deliberate change 4: Python raises IndexError on a
 * whitespace-only first author (`"  ".split()[-1]`); here that author falls through to the title branch.
 */
export function buildShortCite(chunk: Chunk): string {
  const authors = chunk.paper_authors ?? [];
  const year = chunk.paper_year;
  if (authors.length > 0) {
    const first = String(authors[0]);
    const parts = pySplit(first);
    if (!['unknown', 'unknown authors', ''].includes(first.toLowerCase()) && parts.length > 0) {
      let cite = `${parts[parts.length - 1]}${authors.length > 1 ? ' et al.' : ''}`;
      if (year) cite += ` ${year}`;
      return cite;
    }
  }
  const title = chunk.paper_title || chunk.paper_filename || 'Unknown';
  if (year) return `${title} (${year})`;
  return title;
}

/** `eligible_persona_keys`: a non-empty enabled set is a pure intersection; otherwise only feed-eligible personas. */
export function eligiblePersonaKeys(enabled: Set<string> | null | undefined, personas: Personas): string[] {
  if (enabled && enabled.size > 0) return [...personas.keys()].filter((k) => enabled.has(k));
  return [...personas].filter(([, meta]) => meta.feed_eligible).map(([k]) => k);
}

/**
 * `_blend_weights`: blend=0 is all manual, 1 is all learned; keys are manual's then learned's; normalized to 1
 * and rounded to 4 places when the total is positive.
 */
export function blendWeights(
  manual: Record<string, number>,
  learned: Record<string, number>,
  blend: number,
): Record<string, number> {
  const keys = [...new Set([...Object.keys(manual), ...Object.keys(learned)])];
  let blended: Record<string, number> = {};
  for (const k of keys) {
    blended[k] = (manual[k] ?? 0) * (1 - blend) + (learned[k] ?? 0) * blend;
  }
  const total = Object.values(blended).reduce((a, b) => a + b, 0);
  if (total > 0) {
    blended = Object.fromEntries(Object.entries(blended).map(([k, v]) => [k, pyRound(v / total, 4)]));
  }
  return blended;
}

export type PlanOptions = {
  numPosts?: number;
  enabled?: Set<string> | null;
  customWeights?: Record<string, number> | null;
  preferences?: {
    has_signal?: boolean;
    post_type_weights?: Record<string, number>;
    persona_weights?: Record<string, number>;
  } | null;
};

/**
 * `plan_feed_posts`: the sequence of {persona, post_type} slots. Three standalone openers from distinct personas
 * (even when numPosts < 3: W 9.11), then weighted random fill.
 */
export function planFeedPosts(rng: Rng, personas: Personas, opts: PlanOptions = {}): Assignment[] {
  const { numPosts = 12, enabled = null, customWeights = null, preferences = null } = opts;
  let personaKeys = eligiblePersonaKeys(enabled, personas);
  if (personaKeys.length === 0) personaKeys = [...personas.keys()];

  // `custom_weights or POST_TYPE_WEIGHTS`: an empty object is falsy in Python.
  let weightsMap: Record<string, number> =
    customWeights && Object.keys(customWeights).length > 0 ? customWeights : POST_TYPE_WEIGHTS;

  const hasSignal = Boolean(preferences && preferences.has_signal);
  if (hasSignal) {
    const learnedTypes = preferences!.post_type_weights ?? {};
    if (Object.keys(learnedTypes).length > 0) weightsMap = blendWeights(weightsMap, learnedTypes, PREFERENCE_BLEND);
  }
  const postTypes = Object.keys(weightsMap);
  const weights = Object.values(weightsMap);

  let personaWeights: Record<string, number> = Object.fromEntries(personaKeys.map((k) => [k, 1.0]));
  if (hasSignal) {
    const learnedPersona = preferences!.persona_weights ?? {};
    if (Object.keys(learnedPersona).length > 0) {
      const uniform = Object.fromEntries(personaKeys.map((k) => [k, 1.0 / personaKeys.length]));
      const blended = blendWeights(uniform, learnedPersona, PREFERENCE_BLEND);
      personaWeights = Object.fromEntries(personaKeys.map((k) => [k, blended[k] ?? 0.01]));
    }
  }

  const plan: Assignment[] = [];
  for (const pk of sample(rng, personaKeys, Math.min(3, personaKeys.length))) {
    plan.push({ persona: pk, post_type: 'post' });
  }
  const remaining = numPosts - plan.length;
  const pKeys = Object.keys(personaWeights);
  const pWeights = Object.values(personaWeights);
  for (let i = 0; i < remaining; i++) {
    const persona = choices(rng, pKeys, pWeights);
    const postType = choices(rng, postTypes, weights);
    plan.push({ persona, post_type: postType });
  }
  return plan;
}
