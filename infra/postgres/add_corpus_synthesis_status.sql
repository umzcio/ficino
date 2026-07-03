-- Group-chat pending state (Wave-5 Task 4, completing W4's ticket): mirror
-- paper_summaries' status/task_id columns onto corpus_syntheses so
-- create_group_chat can insert a placeholder row at dispatch time instead
-- of the corpus_syntheses row only ever existing once the Celery task has
-- already finished. Before this, GET /messages/groups/{id} 404'd for the
-- entire generation window and a permanently-failed synthesis (retries
-- exhausted) was indistinguishable from a slow one — both were "404
-- forever" from the frontend's point of view.
ALTER TABLE corpus_syntheses
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS task_id TEXT;
-- status: 'generating' | 'error' | 'complete'. Default 'complete' so rows
-- inserted before this migration (which only ever existed once the worker
-- had already produced messages) read as already-complete, matching their
-- actual state — no backfill needed.
