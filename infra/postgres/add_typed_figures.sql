-- Typed figures + persona figure-type routing.
--
-- Current state: `figures` stores only {description, claim_summary} on any
-- embedded bitmap from the PDF. This indiscriminately captures UI glyphs,
-- publisher logos, and inline photographs alongside actual scientific
-- figures, and there's no way for post-generation to route only the right
-- figure types to the right personas. Result: Methods Skeptic earnestly
-- analyzes a document icon, Stats Nerd tries to do statistics on a
-- photograph of two doors.
--
-- New columns on `figures`:
--   figure_type          — one of {chart_bar, chart_line, chart_scatter,
--                          chart_other, diagram, schematic, flowchart,
--                          algorithm, photograph, map, micrograph,
--                          anatomical, table_image, other}
--                          Non-figure detections (icons, logos) are not
--                          stored at all by the VLM detector.
--   caption              — actual caption text ("Fig. 5. Two green doors...")
--                          captured at detection time.
--   figure_number        — "5", "5a", "S3", etc., for cross-reference from
--                          text that cites the figure.
--   data_claim           — the paper's OWN framing of what this figure
--                          shows, used as grounding for persona prompts.
--   referenced_paragraph — first paragraph of body text that cites this
--                          figure number, used alongside caption for
--                          grounded post generation.
--   bbox                 — {page, x0, y0, x1, y1} of the figure within the
--                          rendered page, for click-through and audit.
--   detector_confidence  — VLM confidence score (0.0–1.0). Lets us threshold
--                          low-confidence detections without re-running.
--
-- New column on `personas`:
--   allowed_figure_types — array of figure_type strings this persona is
--                          allowed to make "figure" posts about. NULL means
--                          "not allowed to post about any figure" — the
--                          persona still generates post/thread/quote/reply
--                          posts about text chunks, it just never gets
--                          offered a figure it can't talk about.
--
-- Nullable because figures ingested pre-migration have no typed data. Those
-- rows are effectively dead to figure-post routing (NULL figure_type → no
-- persona's allowed list contains NULL) and should be re-ingested when the
-- paper is re-uploaded.
--
-- Run with: docker exec -i ficino-postgres psql -U ficino -d ficino \
--   < infra/postgres/add_typed_figures.sql

BEGIN;

ALTER TABLE figures
  ADD COLUMN IF NOT EXISTS figure_type          TEXT,
  ADD COLUMN IF NOT EXISTS caption              TEXT,
  ADD COLUMN IF NOT EXISTS figure_number        TEXT,
  ADD COLUMN IF NOT EXISTS data_claim           TEXT,
  ADD COLUMN IF NOT EXISTS referenced_paragraph TEXT,
  ADD COLUMN IF NOT EXISTS bbox                 JSONB,
  ADD COLUMN IF NOT EXISTS detector_confidence  REAL;

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS allowed_figure_types TEXT[];

-- Seed the agreed-upon mapping. See the persona→figure-type table in the
-- RAG / figure-pipeline design discussion. Using explicit enum values
-- rather than wildcards so that adding a new figure_type later (e.g.
-- chart_heatmap) requires a deliberate decision about which personas
-- get it, not a silent broadening.
UPDATE personas SET allowed_figure_types = ARRAY[
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'schematic', 'flowchart', 'algorithm'
] WHERE key = 'skeptic';

UPDATE personas SET allowed_figure_types = ARRAY[
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'photograph', 'map', 'micrograph'
] WHERE key = 'hype';

UPDATE personas SET allowed_figure_types = ARRAY[
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'schematic', 'algorithm', 'flowchart'
] WHERE key = 'practitioner';

UPDATE personas SET allowed_figure_types = ARRAY[
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'schematic', 'flowchart', 'algorithm'
] WHERE key = 'methodologist';

-- Grad Student plays curious-generalist: allowed on every concrete type.
UPDATE personas SET allowed_figure_types = ARRAY[
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'schematic', 'flowchart', 'algorithm',
  'photograph', 'map', 'micrograph', 'anatomical',
  'table_image', 'other'
] WHERE key = 'gradstudent';

-- Amplifier, if present (see add_amplifier_persona.sql). Same posture as hype.
UPDATE personas SET allowed_figure_types = ARRAY[
  'chart_bar', 'chart_line', 'chart_scatter', 'chart_other',
  'diagram', 'photograph', 'map', 'micrograph'
] WHERE key = 'amplifier';

-- Archivist replies to user posts — not a feed persona, no figure-post routing.
UPDATE personas SET allowed_figure_types = NULL WHERE key = 'archivist';

COMMIT;
