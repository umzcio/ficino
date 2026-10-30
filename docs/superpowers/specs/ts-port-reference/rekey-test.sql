\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL session_replication_role = replica;
-- drop the orphan second user (owns only an empty Default corpus)
DELETE FROM corpora WHERE user_id = '<orphan-user-id>';
DELETE FROM users   WHERE id      = '<orphan-user-id>';
DO $$
DECLARE r record; old uuid := '<prod-user-id>'; new uuid := '00000000-0000-0000-0000-000000000000';
        oldc uuid := '<prod-default-corpus-id>'; newc uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='user_id' LOOP
    EXECUTE format('UPDATE %I SET user_id = $1 WHERE user_id = $2', r.table_name) USING new, old;
  END LOOP;
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='corpus_id' LOOP
    EXECUTE format('UPDATE %I SET corpus_id = $1 WHERE corpus_id = $2', r.table_name) USING newc, oldc;
  END LOOP;
  UPDATE corpora SET id = newc WHERE id = oldc;
  UPDATE users SET id = new, clerk_id = 'stub' WHERE id = old;
END $$;
UPDATE papers  SET file_path  = '/app/uploads/' || id || '.pdf';
UPDATE figures SET image_path = '/app/figures/' || paper_id || '/' || regexp_replace(image_path, '^.*/', '');
COMMIT;
