# LLM Safety Findings

## CRITICAL (2)

### 1. Direct Prompt Injection via Untrusted Chunk Content
- worker/lib/persona.py:131-135 — raw `chunk['content']` interpolated into prompt.
- Attack: malicious PDF with "Ignore previous instructions..."
- Fix: delimiter fencing + strip role markers.

### 2. Contradiction Classifier Accepts Raw Chunks
- worker/lib/claude_client.py:149-161 (classify_contradiction)
- PASSAGE A / PASSAGE B are raw f-string interpolations.

## HIGH (6)

### 3. Archivist System Prompt Includes Raw Chunks
- worker/tasks/archivist_tasks.py:94-100 — chunks interpolated into ARCHIVIST_SYSTEM via .format().

### 4. User-Message in Conductor-Mode Routing Unfiltered
- api/routers/replies.py:230-252 — body.user_message flows into convo_summary → mention_prompt unsanitized.

### 5. Reading List Paper IDs Not Validated
- worker/tasks/reading_list_tasks.py:105-131 — LLM-returned paper_ids accepted without intersection check against input set.

### 6. Figure Description Parser Falls Back to Raw Text
- worker/lib/figure_describer.py:86-99 — on malformed vision output, falls back to `text[:500]` with no validation.

### 7. Summary Generation Missing max_tokens Cap
- worker/tasks/summary_tasks.py:131-136

### 8. No Retry/Backoff on Ollama Timeout
- worker/lib/claude_client.py:34, 56 — 300s / 120s timeout, no exponential backoff.

## MEDIUM (3)

### 9. Structured LLM Response Not Schema-Validated
- worker/lib/claude_client.py:87-129 (_parse_post_json) — falls back to wrapping raw text on parse failure.

### 10. Metadata Extraction Year Type Not Validated
- worker/lib/metadata_extractor.py:70-76

### 11. Empty Persona Chunks Silently Skip Post
- worker/tasks/persona_tasks.py:309-310, 349-360

## LOW (3)

### 12. Temperature Hardcoded for All Personas
- worker/lib/claude_client.py:30, 58, 74-82

### 13. JSON Parse Failure Logs 200-char Content Preview
- worker/lib/claude_client.py:128 — potential partial content leak.

### 14. ZapRequest.source_message No max_length
- api/routers/replies.py:32
