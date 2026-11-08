// Port of worker/tasks/reading_list_tasks.py generate_chapter's pure parts: the chapter's system-prompt suffix, its
// cumulative paper scope, the prompt post type and the post finishing (W §2.8). Pinned to
// test/fixtures/goldens/chapter-tasks.json.
import type { Logger } from 'pino';
import { groundPost, startPost } from '../feed/slots.js';
import type { Chunk, FeedFigure, Post } from '../feed/types.js';
import type { Rng } from '../shared/random.js';

/** The suffix appended to the persona's system prompt. Chapter 0 keeps the trailing space. */
export function chapterContext(chapterIndex: number): string {
  let out = `\nThis is Chapter ${chapterIndex + 1} of a reading list. `;
  if (chapterIndex > 0) {
    out += `The reader has already covered ${chapterIndex} prior paper(s). Build on that foundation — reference earlier papers when relevant.`;
  }
  return out;
}

/**
 * The chapter's cumulative scope: the sequence up to and including the first occurrence of the chapter's last paper
 * (Python's `list.index`; `propose_ordering` can persist duplicate ids), else the chapter's own ids.
 */
export function chapterScope(sequence: string[], chapterPaperIds: string[]): string[] {
  const last = chapterPaperIds.length > 0 ? chapterPaperIds[chapterPaperIds.length - 1]! : null;
  if (last && sequence.includes(last)) return sequence.slice(0, sequence.indexOf(last) + 1);
  return [...chapterPaperIds];
}

/** The type the prompt is built for: `quote` and `reply` (and anything else) are prompted as plain posts. */
export function promptPostType(planned: string): string {
  return planned === 'post' || planned === 'thread' || planned === 'figure' ? planned : 'post';
}

export type FinishChapterPostOpts = {
  personaKey: string;
  /** The planned slot type (not the prompt type): kept when the LLM omits `post_type` (or claims a figure it lacks). */
  plannedType: string;
  /** The plan's loop index, so skipped or failed slots leave id and time gaps. */
  slotIndex: number;
  chunks: Chunk[];
  figure: FeedFigure | null;
  logger: Logger;
};

/**
 * Everything generate_chapter does to an LLM post before `posts.append`: the model's text fields only (startPost),
 * persona, the planned type when absent,
 * id and time from the loop index (no `_task_id`), then generate_feed's grounding tail (cite, figure, sources,
 * category, engagement defaults, shape validation, which throws to drop the post).
 */
export function finishChapterPost(rng: Rng, raw: Post, o: FinishChapterPostOpts): Post {
  const post = startPost(raw, o.personaKey, o.plannedType, o.figure);
  post.id = o.slotIndex + 1;
  post.time = `${(o.slotIndex + 1) * 2}m`;
  return groundPost(rng, post, {
    personaKey: o.personaKey,
    chunks: o.chunks,
    figure: o.figure,
    tabCategory: null,
    logger: o.logger,
  });
}
