-- Research Digest — Supabase schema
--
-- Apply this once to a fresh Supabase project, then set RLS policies as
-- described at the bottom. The pipeline writes via SUPABASE_SERVICE_KEY;
-- the frontend reads via the publishable anon key.
--
-- Apply via the Supabase SQL editor or `psql`:
--   psql "$DATABASE_URL" -f schema.sql

-- ── digest_papers ──────────────────────────────────────────────────────────
-- Curated papers per weekly run. Frontend reads (anon); pipeline writes (service).

CREATE TABLE IF NOT EXISTS public.digest_papers (
  id                   SERIAL PRIMARY KEY,
  paper_id             TEXT UNIQUE NOT NULL,    -- slugified DOI when present, else PMID-derived
  pmid                 TEXT,
  doi                  TEXT,
  title                TEXT NOT NULL,
  authors              TEXT[],
  journal              TEXT,
  pub_date             DATE,
  abstract             TEXT,
  tags                 TEXT[],
  source               TEXT,                    -- e.g. "Journal: Cell Metabolism"
  relevance            TEXT,                    -- 'high' / 'medium' / 'low'
  batch                TEXT,                    -- run date string
  embedding_core       NUMERIC,
  embedding_methods    NUMERIC,
  embedding_adjacent   NUMERIC,
  embedding_combined   NUMERIC,
  sonnet_relevance     NUMERIC,
  sonnet_surprise      NUMERIC,
  sonnet_combined      NUMERIC,                 -- primary sort key
  sonnet_reason        TEXT,
  scoring_method       TEXT,                    -- 'full' | 'embedding-only' | 'partial'
  ai_summary           TEXT,
  why_it_matters       TEXT,
  full_text_summary    TEXT,                    -- rendered HTML (sanitized client-side)
  is_wildcard          BOOLEAN DEFAULT false,
  is_preprint          BOOLEAN DEFAULT false,
  added_date           TIMESTAMPTZ DEFAULT now(),
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS digest_papers_pub_date_idx   ON public.digest_papers (pub_date DESC);
CREATE INDEX IF NOT EXISTS digest_papers_added_date_idx ON public.digest_papers (added_date DESC);
CREATE INDEX IF NOT EXISTS digest_papers_relevance_idx  ON public.digest_papers (relevance);

-- ── digest_grants ──────────────────────────────────────────────────────────
-- NIH Reporter grants. Same access pattern as digest_papers.

CREATE TABLE IF NOT EXISTS public.digest_grants (
  id                   SERIAL PRIMARY KEY,
  grant_id             TEXT UNIQUE NOT NULL,    -- core_project_num
  title                TEXT NOT NULL,
  pi                   TEXT,
  organization         TEXT,
  org_city             TEXT,
  org_state            TEXT,
  mechanism            TEXT,                    -- R01, R21, P01, ...
  amount               NUMERIC,
  fiscal_year          INTEGER,
  start_date           DATE,
  end_date             DATE,
  award_date           DATE,
  abstract             TEXT,
  url                  TEXT,
  source               TEXT,                    -- search label
  tags                 TEXT[],
  relevance            TEXT,
  embedding_combined   NUMERIC,
  sonnet_relevance     NUMERIC,
  sonnet_surprise      NUMERIC,
  sonnet_combined      NUMERIC,
  sonnet_reason        TEXT,
  scoring_method       TEXT,
  ai_summary           TEXT,
  why_it_matters       TEXT,
  is_new               BOOLEAN DEFAULT true,
  batch                TEXT,
  study_section        TEXT,
  added_date           TIMESTAMPTZ DEFAULT now(),
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS digest_grants_award_date_idx ON public.digest_grants (award_date DESC);

-- ── papers (saved library) ─────────────────────────────────────────────────
-- User-curated subset. Frontend reads (anon) and writes (service via API routes).
-- The paper_id column historically holds raw PMID/DOI rather than the slugified
-- form used in digest_papers. This is preserved on the write path in
-- api/feedback.js so saves de-duplicate against existing rows.

CREATE TABLE IF NOT EXISTS public.papers (
  id                   SERIAL PRIMARY KEY,
  paper_id             TEXT UNIQUE NOT NULL,
  pmid                 TEXT,
  doi                  TEXT,
  title                TEXT NOT NULL,
  authors              TEXT[],
  journal              TEXT,
  pub_date             DATE,
  abstract             TEXT,
  tags                 TEXT[],
  source               TEXT,
  relevance            TEXT,
  ai_summary           TEXT,
  why_it_matters       TEXT,
  full_text_summary    TEXT,                    -- rendered HTML (sanitized client-side)
  status               TEXT,                    -- 'saved' | 'summary_pending' | 'summary_deferred' | 'summary_ready' | 'summary_failed' | 'removed'
  wants_deep_summary   BOOLEAN DEFAULT false,
  retry_count          INTEGER DEFAULT 0,
  last_attempt         TIMESTAMPTZ,
  access_method        TEXT,                    -- 'pmc' / 'europepmc' / 'unpaywall' / 'biorxiv'
  full_summary         JSONB,                   -- structured JSON output of process-summary-queue.js
  summarized_date      TIMESTAMPTZ,
  notes                TEXT,
  saved_date           TIMESTAMPTZ DEFAULT now(),
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS papers_status_idx     ON public.papers (status);
CREATE INDEX IF NOT EXISTS papers_saved_date_idx ON public.papers (saved_date DESC);

-- ── feedback_events ────────────────────────────────────────────────────────
-- Triage feedback log: which papers were shown vs. selected vs. removed.
-- Used for negative-signal embedding profile updates (planned).

CREATE TABLE IF NOT EXISTS public.feedback_events (
  id              SERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL,                -- 'shown' | 'selected' | 'removed'
  shown_pmids     TEXT[],
  selected_pmids  TEXT[],
  paper_id        TEXT,
  user_id         TEXT,                         -- optional, if multi-user later
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_events_created_idx ON public.feedback_events (created_at DESC);

-- ── Row Level Security ─────────────────────────────────────────────────────
-- Public read via anon key; writes require service role.
-- Apply these in the Supabase dashboard under Authentication → Policies.

ALTER TABLE public.digest_papers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digest_grants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.papers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_events  ENABLE ROW LEVEL SECURITY;

-- Public read on the four tables (anon key has SELECT)
CREATE POLICY "anon read digest_papers"   ON public.digest_papers   FOR SELECT TO anon USING (true);
CREATE POLICY "anon read digest_grants"   ON public.digest_grants   FOR SELECT TO anon USING (true);
CREATE POLICY "anon read papers"          ON public.papers          FOR SELECT TO anon USING (true);
-- feedback_events: no anon read (write-only via service)

-- Writes via service_role key — implicit; service_role bypasses RLS.
-- No policies needed for the service role.
