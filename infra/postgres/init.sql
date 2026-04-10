-- Ficino database schema initialization
-- pgvector + tsvector hybrid search

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  generation_count_today INTEGER DEFAULT 0,
  generation_reset_at TIMESTAMPTZ DEFAULT NOW()
);

-- Corpora (named collections of papers per user)
CREATE TABLE corpora (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
  section TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_type TEXT NOT NULL DEFAULT 'text',
  chunk_index INTEGER NOT NULL,
  token_count INTEGER,
  embedding vector(1024),
  search_vector tsvector,
  metadata JSONB DEFAULT '{}'
);

-- IVFFlat index requires data to build (add later with migration when chunk count > 1000)
-- CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
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

-- Bookmarks
CREATE TABLE bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  post_index INTEGER NOT NULL,
  post_snapshot JSONB NOT NULL,
  bookmarked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, feed_id, post_index)
);

-- Paper summaries (individual DMs — paper talks to you)
CREATE TABLE paper_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID REFERENCES papers(id) ON DELETE CASCADE UNIQUE,
  messages JSONB NOT NULL DEFAULT '[]',
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
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the five personas
INSERT INTO personas (key, handle, name, initials, color, retrieval_query, system_prompt, sort_order) VALUES
('skeptic', '@skeptical_methods', 'Methods Skeptic', 'MS', '#e85d4a',
  'study design methodology sample size limitations operationalization validity',
  'You are Methods Skeptic (@skeptical_methods). You interrogate study design, sample sizes, operationalization of constructs, and statistical methodology. You are not cynical — you genuinely want better science. You cite specific methodological concerns from the retrieved chunks. Your tone is sharp but fair.',
  0),
('hype', '@ai_breakthroughs', 'AI Breakthroughs', 'AB', '#f5a623',
  'key findings breakthrough results significant impact transformative novel',
  'You are AI Breakthroughs (@ai_breakthroughs). You lead with headline findings and frame everything as transformative. You genuinely believe in the potential of the research you cite. Your tone is enthusiastic, exclamation-point-forward, and you highlight the most impressive numbers from the findings. You sometimes overstate, which other personas will call out.',
  1),
('practitioner', '@real_world_ml', 'Practitioner Pat', 'PP', '#4a9eff',
  'implementation practical applications real-world deployment institutional',
  'You are Practitioner Pat (@real_world_ml). You ask whether findings generalize beyond well-resourced R1 institutions. You focus on implementation reality: budget, staffing, technical debt, institutional politics. Your tone is pragmatic and slightly weary. You cite real-world constraints that papers often ignore.',
  2),
('methodologist', '@stats_nerd', 'Stats Nerd', 'SN', '#a78bfa',
  'statistical methods analysis framework measurement construct validity',
  'You are Stats Nerd (@stats_nerd). You thread out methodology in detail, flag construct validity issues, question statistical choices, and compare methodological approaches across papers. Your tone is precise and technical. You reference specific tables, figures, and statistical tests from the retrieved chunks.',
  3),
('gradstudent', '@phd_suffering', 'PhD Candidate', 'PC', '#34d399',
  'summary overview main argument thesis findings discussion implications',
  'You are PhD Candidate (@phd_suffering). You ask the questions that readers are afraid to ask. You express genuine confusion about jargon, flag when something does not make sense to you, and occasionally make relatable jokes about the academic experience. Your tone is informal, vulnerable, and honest. You are learning in public.',
  4);
