// Shared types for the feed generator (plan 03). Task 3 adds FeedFigure and Contradiction here.

/** One row of the personas table. Mirrors the dict worker/lib/persona.py get_personas() builds. */
export type Persona = {
  key: string;
  handle: string;
  name: string;
  initials: string;
  color: string;
  system_prompt: string;
  /** null = fall back to the user's persona_temperature setting. */
  temperature: number | null;
  retrieval_query: string | null;
  /** null = no figure posts for this persona. */
  allowed_figure_types: string[] | null;
  /** false for reply-only personas (archivist). */
  feed_eligible: boolean;
};

/** Active personas by key, in DB sort_order (Map keeps insertion order). */
export type Personas = Map<string, Persona>;

/** A retrieved chunk with its paper metadata and ranking. */
export type Chunk = {
  id: string;
  paper_id: string;
  section: string | null;
  content: string;
  chunk_type: string | null;
  chunk_index: number;
  token_count: number | null;
  paper_title: string | null;
  paper_authors: string[];
  paper_year: number | null;
  paper_filename: string | null;
  score: number;
  match_type: 'hybrid' | 'keyword' | 'vector' | 'anchor';
  rerank_score?: number;
  boosted?: true;
};

/** A generated post row / payload (shape varies by post type). */
export type Post = Record<string, unknown>;

/** One slot of a feed plan. */
export type Assignment = { persona: string; post_type: string };
