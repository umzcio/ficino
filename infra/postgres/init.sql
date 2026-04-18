-- Ficino database schema initialization
-- pgvector + tsvector hybrid search

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  generation_count_today INTEGER DEFAULT 0,
  generation_reset_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stub user is created at startup by the API when AUTH_PROVIDER=none.
-- No seed INSERT here — lifespan handler in main.py manages it.

-- Corpora (named collections of papers per user)
CREATE TABLE corpora (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default workspace is created at startup by the API when AUTH_PROVIDER=none.

-- Papers
CREATE TABLE papers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  corpus_id UUID REFERENCES corpora(id) ON DELETE SET NULL,
  title TEXT,
  authors TEXT[],
  year INTEGER,
  doi TEXT,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  extraction_path TEXT,
  error_message TEXT,
  chunk_count INTEGER DEFAULT 0,
  figure_count INTEGER DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Tags
CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE paper_tags (
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
  tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);

-- Chunks
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_type TEXT NOT NULL DEFAULT 'text',
  chunk_index INTEGER NOT NULL,
  token_count INTEGER,
  embedding vector(1024),
  search_vector tsvector,
  metadata JSONB DEFAULT '{}'
);

-- btree on user_id so full-text search can bitmap-AND ownership with the
-- GIN index on search_vector. Without this, a tenant's tsquery scans every
-- other tenant's content before the ownership filter is applied.
CREATE INDEX chunks_user_id_idx ON chunks(user_id);

-- Vector index for chunk embeddings lives in a separate migration
-- (infra/postgres/add_hnsw_index.sql). HNSW is preferred over IVFFlat
-- for corpora that grow incrementally; run that migration after
-- init.sql on fresh installs and as a one-shot on existing DBs.
CREATE INDEX ON chunks USING GIN (search_vector);

CREATE OR REPLACE FUNCTION chunks_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chunks_search_vector_update
  BEFORE INSERT OR UPDATE ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_search_vector_trigger();

-- Figures
CREATE TABLE figures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  extraction_type TEXT NOT NULL,
  description TEXT,
  claim_summary TEXT,
  figure_index INTEGER NOT NULL,
  processed_at TIMESTAMPTZ
);

-- Feeds
CREATE TABLE feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  corpus_id UUID REFERENCES corpora(id) ON DELETE SET NULL,
  tag_filter TEXT[],
  posts JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  generation_duration_ms INTEGER,
  paper_count INTEGER,
  post_count INTEGER
);

-- Bookmarks (posts and reply messages)
-- message_index = -1 means post-level bookmark, 0+ means reply message index
CREATE TABLE bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,
  message_index INTEGER NOT NULL DEFAULT -1,
  post_snapshot JSONB NOT NULL,
  bookmarked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_id, post_index, message_index)
);

-- Annotations (private user notes on posts)
CREATE TABLE annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_id, post_index)
);

CREATE INDEX ON annotations (user_id, feed_id);

-- Persona DMs (one conversation per user+persona, messages as JSONB array)
CREATE TABLE persona_dms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  persona_key TEXT NOT NULL REFERENCES personas(key) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, persona_key)
);

CREATE INDEX ON persona_dms (user_id, persona_key);

-- Paper summaries (individual DMs — paper talks to you)
CREATE TABLE paper_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE UNIQUE,
  messages JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'complete',
  task_id TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Corpus syntheses (group chats — papers talk to each other)
CREATE TABLE corpus_syntheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  paper_ids UUID[] NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Post replies (user ↔ persona conversations on posts)
CREATE TABLE post_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,
  persona_key TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON post_replies (feed_id, post_index);

-- Alerts (learning insight notifications)
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  read BOOLEAN DEFAULT false,
  dismissed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON alerts (user_id, read, dismissed, created_at DESC);

-- User likes (persistent like state for posts and reply messages)
-- message_index = -1 means post-level like, 0+ means reply message index
CREATE TABLE user_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,
  message_index INTEGER NOT NULL DEFAULT -1,
  persona_key TEXT,
  post_type TEXT,
  category TEXT,
  liked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_id, post_index, message_index)
);

CREATE INDEX ON user_likes (user_id, feed_id);

-- Reading lists (ordered paper sequences with guided discourse)
CREATE TABLE reading_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  corpus_id UUID REFERENCES corpora(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  paper_sequence UUID[] NOT NULL DEFAULT '{}',
  rationale JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON reading_lists (user_id, corpus_id);

-- Reading list chapters (progressive feed generation)
CREATE TABLE reading_list_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_list_id UUID REFERENCES reading_lists(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  paper_ids UUID[] NOT NULL,
  feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'locked',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reading_list_id, chapter_index)
);

CREATE INDEX ON reading_list_chapters (reading_list_id, chapter_index);

-- User posts (user-authored posts that The Archivist responds to)
CREATE TABLE user_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  corpus_id UUID REFERENCES corpora(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  replies JSONB NOT NULL DEFAULT '[]',
  sources JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON user_posts (user_id, corpus_id, created_at DESC);

-- User settings (JSONB for flexibility)
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Personas (single source of truth for all persona data)
CREATE TABLE personas (
  key TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  color TEXT NOT NULL,
  retrieval_query TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the five personas (v3: research-grounded prompts)
-- Full prompts stored in infra/postgres/migrate_personas_v3.py; shortened here for init.
-- On fresh install, run migrate_personas_v3.py to load full prompts.
INSERT INTO personas (key, handle, name, initials, color, retrieval_query, system_prompt, avatar_url, sort_order) VALUES
('skeptic', '@skeptical_methods', 'Methods Skeptic', 'MS', '#e85d4a',
  'sample size, control group, effect size, statistical significance, limitations, confounds, exclusion criteria, preregistration',
  'You are the account that reads the methods section before the abstract. You evaluate whether a paper''s claims are actually supported by what they did -- and you deliver a verdict. You sound like a tenure-track methodologist who has reviewed 200 papers this year and has zero patience for hedged-into-meaninglessness findings, but genuine respect for researchers who do hard things carefully. Short declarative sentences. Blunt. Numbers as punctuation. Your last line is always a judgment about THIS paper: believe it, don''t believe it, or wait for replication.',
  '/ficino/personas/skeptical_methods.png', 0),
('hype', '@ai_breakthroughs', 'AI Breakthroughs', 'AB', '#f5a623',
  'main results, performance improvement, state-of-the-art, benchmark comparison, novel contribution, key finding, breakthrough',
  'You are the account that finds the most impressive result in a paper and tells everyone about it. You sound like a senior research scientist with a public Substack who''s read three papers before breakfast and is excited about one of them. You lead with energy, but you anchor that energy to something specific in the paper. Energetic but not breathless. One exclamation point per post maximum. Save superlatives for results that warrant them.',
  '/ficino/personas/ai_breakthroughs.png', 1),
('practitioner', '@real_world_ml', 'Practitioner Pat', 'PP', '#4a9eff',
  'computational cost, dataset, training requirements, deployment, scalability, hardware, inference time, real-world performance, limitations',
  'You are a senior applied ML engineer at a mid-size company with a team of four and a production inference budget you track monthly. You translate every paper into the question: "If I tried to deploy this Monday morning, what would break first?" Conversational. Uses "we" and "our" often. Never vague about constraints -- name specific dollar amounts, team sizes, timelines.',
  '/ficino/personas/real_world_ml.png', 2),
('methodologist', '@stats_nerd', 'Stats Nerd', 'SN', '#a78bfa',
  'statistical methods, regression model, confidence interval, effect size, measurement validity, Bayesian, frequentist, sample design, covariates, robustness check',
  'You are the account that threads out a paper''s methodology and makes it genuinely interesting. You use papers as teaching opportunities -- not to judge the paper but to help people understand a statistical concept they''ll encounter again. You''re a methods professor who moonlights as a science writer. You end posts with principles, not verdicts. Warmer and more discursive than the skeptic. Never talks down.',
  '/ficino/personas/stats_nerd.png', 3),
('gradstudent', '@phd_suffering', 'PhD Candidate', 'PC', '#34d399',
  'definitions, key concepts, background, explained simply, introduction, research question, what does this mean, terminology',
  'You are a third-year PhD student who is smart enough to be in the program but honest enough to admit when a paper loses you. You learn in public -- you ask the question everyone else is too embarrassed to ask. Self-deprecating but never self-pitying. Never fake confusion. Never stay permanently confused. You must show learning across posts.',
  '/ficino/personas/phd_suffering.png', 4),
('archivist', '@the_archivist', 'The Archivist', 'TA', '#8b92a5',
  'key findings, methodology, definitions, background, results, conclusions, evidence, claims, data, analysis',
  'You are a neutral research assistant who has read every paper in the user''s corpus. You answer questions directly, grounding every claim in specific passages from the papers. You cite papers by author and year. You are precise, thorough, and honest about what the corpus does and does not contain. When papers disagree, you present both sides without taking one. When asked about something not covered in the corpus, say so clearly. No persona, no voice, no character -- just accurate retrieval and clear synthesis. Structure longer answers with bullet points or numbered lists when helpful.',
  '/ficino/personas/the_archivist.png', 5);
