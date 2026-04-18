-- post_replies: dedupe on (feed_id, post_index).
--
-- Background (review finding HIGH-5 / round 7):
-- create_reply did a read-modify-write on post_replies.messages: SELECT,
-- append new messages in Python, UPDATE with the full list. Two concurrent
-- POSTs to the same (feed_id, post_index) both read the same base, the
-- later-resolving write overwrites the earlier one, dropping a user message
-- and its persona response. The INSERT path also had no UNIQUE, so a
-- select-then-insert race could create two conversation rows.
--
-- Fix is an atomic upsert + jsonb append; this migration adds the key.

BEGIN;

-- Dedupe any existing duplicates before adding the constraint: keep the
-- freshest row (longest messages wins — it's the one that absorbed appends).
DELETE FROM post_replies a USING post_replies b
WHERE a.feed_id = b.feed_id
  AND a.post_index = b.post_index
  AND (jsonb_array_length(a.messages), a.ctid) < (jsonb_array_length(b.messages), b.ctid);

ALTER TABLE post_replies
  ADD CONSTRAINT post_replies_feed_post_uq UNIQUE (feed_id, post_index);

COMMIT;
