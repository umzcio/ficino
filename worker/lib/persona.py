"""Persona prompt construction and feed generation.

Constructs prompts for each of the five personas using retrieved chunks
and contradiction context. Generates structured JSON posts that the
frontend can render directly.
"""

import json
import random

import structlog

from lib.db import fetch

logger = structlog.get_logger(__name__)

# Post type distribution weights (approximate)
POST_TYPE_WEIGHTS = {
    "post": 0.35,
    "thread": 0.10,
    "quote": 0.20,
    "reply": 0.25,
    "figure": 0.10,
}

PERSONAS = {
    "skeptic": {
        "handle": "@skeptical_methods",
        "name": "Methods Skeptic",
        "initials": "MS",
        "color": "#e85d4a",
    },
    "hype": {
        "handle": "@ai_breakthroughs",
        "name": "AI Breakthroughs",
        "initials": "AB",
        "color": "#f5a623",
    },
    "practitioner": {
        "handle": "@real_world_ml",
        "name": "Practitioner Pat",
        "initials": "PP",
        "color": "#4a9eff",
    },
    "methodologist": {
        "handle": "@stats_nerd",
        "name": "Stats Nerd",
        "initials": "SN",
        "color": "#a78bfa",
    },
    "gradstudent": {
        "handle": "@phd_suffering",
        "name": "PhD Candidate",
        "initials": "PC",
        "color": "#34d399",
    },
}


def get_active_persona_prompts() -> dict[str, str]:
    """Fetch active persona system prompts from the database."""
    rows = fetch(
        "SELECT persona_key, system_prompt FROM persona_prompts WHERE is_active = true"
    )
    return {row["persona_key"]: row["system_prompt"] for row in rows}


def _format_chunks_for_prompt(chunks: list[dict[str, object]]) -> str:
    """Format retrieved chunks into a readable context block for the LLM."""
    parts: list[str] = []
    for i, chunk in enumerate(chunks):
        paper_ref = chunk.get("paper_title") or chunk.get("paper_filename", "Unknown")
        authors = chunk.get("paper_authors", [])
        author_str = ", ".join(str(a) for a in authors[:3]) if authors else "Unknown authors"
        section = chunk.get("section", "unknown")

        parts.append(
            f"[Source {i+1}: {paper_ref} by {author_str} — Section: {section}]\n"
            f"{chunk['content']}\n"
        )
    return "\n---\n".join(parts)


def _format_contradictions(contradictions: list[dict[str, object]]) -> str:
    """Format contradiction pairs into a prompt section."""
    if not contradictions:
        return ""

    parts = ["CONTRADICTIONS DETECTED between papers:"]
    for c in contradictions:
        parts.append(
            f"- Chunk from {c.get('paper_a', '?')}: \"{str(c.get('content_a', ''))[:150]}...\"\n"
            f"  vs Chunk from {c.get('paper_b', '?')}: \"{str(c.get('content_b', ''))[:150]}...\"\n"
            f"  Relationship: {c.get('relationship', 'unknown')}"
        )
    return "\n".join(parts)


def build_post_prompt(
    persona_key: str,
    post_type: str,
    chunks: list[dict[str, object]],
    contradictions: list[dict[str, object]] | None = None,
    existing_posts: list[dict[str, object]] | None = None,
    figure: dict[str, object] | None = None,
) -> str:
    """Build the user prompt for generating a single post.

    Includes retrieved chunks, contradiction context, and (for quotes/replies)
    the post being responded to.
    """
    context = _format_chunks_for_prompt(chunks)
    contradiction_context = _format_contradictions(contradictions or [])

    persona_info = PERSONAS[persona_key]

    base = f"""You are writing as {persona_info['name']} ({persona_info['handle']}) for an academic discourse feed.

RETRIEVED PAPER CONTENT:
{context}

{contradiction_context}

Generate a single {post_type} post. You MUST respond with valid JSON only — no other text.

"""

    if post_type == "post":
        base += """Generate a standalone post about a finding from the retrieved content.

JSON format:
{
  "post_type": "post",
  "content": "Your post text (1-3 sentences, punchy, opinionated)",
  "paper_ref": "Author et al. YEAR"
}"""

    elif post_type == "thread":
        thread_count = random.randint(4, 6)
        base += f"""Generate a FULL thread of {thread_count} posts breaking down a key aspect of the research.
Each post in the thread should be 2-4 sentences and cover a distinct point.

JSON format:
{{
  "post_type": "thread",
  "paper_ref": "Author et al. YEAR",
  "thread_count": {thread_count},
  "thread_posts": [
    "First post — the hook. What are we breaking down and why it matters.",
    "Second post — the setup. Context or background needed to understand the finding.",
    "Third post — the key finding or insight. Specific numbers or claims.",
    "Fourth post — the implication or critique. So what does this mean?"
  ]
}}

IMPORTANT: "thread_posts" must be an array of {thread_count} strings. Each string is one post in the thread. Do NOT number them (no "1/" prefixes) — the UI handles numbering."""

    elif post_type == "quote":
        # Pick a post to quote
        if existing_posts:
            quoted = random.choice(existing_posts)
            base += f"""React to this post by another persona by quote-tweeting it:

ORIGINAL POST by {quoted.get('persona', 'unknown')}:
"{quoted.get('content', '')[:200]}"

JSON format:
{{
  "post_type": "quote",
  "content": "Your reaction/pushback/agreement (1-2 sentences)",
  "paper_ref": "Author et al. YEAR or null",
  "quoting_handle": "{PERSONAS.get(str(quoted.get('persona', '')), {}).get('handle', '@unknown')}",
  "quoting_content": "{str(quoted.get('content', ''))[:150]}..."
}}"""
        else:
            # Fall back to a regular post if nothing to quote
            base += """Generate a standalone post.

JSON format:
{
  "post_type": "post",
  "content": "Your post text",
  "paper_ref": "Author et al. YEAR"
}"""

    elif post_type == "reply":
        if existing_posts:
            replied_to = random.choice(existing_posts)
            reply_handle = PERSONAS.get(str(replied_to.get("persona", "")), {}).get("handle", "@unknown")
            base += f"""Reply to this post by {reply_handle}:

"{replied_to.get('content', '')[:200]}"

JSON format:
{{
  "post_type": "reply",
  "content": "Your reply (1-2 sentences, continue the argument)",
  "paper_ref": "Author et al. YEAR or null",
  "replying_to": "{reply_handle}"
}}"""
        else:
            base += """Generate a standalone post.

JSON format:
{
  "post_type": "post",
  "content": "Your post text",
  "paper_ref": "Author et al. YEAR"
}"""

    elif post_type == "figure":
        if figure:
            fig_desc = figure.get("description", "No description available")
            fig_claim = figure.get("claim_summary", "")
            fig_paper = figure.get("paper_ref", "Unknown")
            fig_page = figure.get("page_number", "?")
            fig_idx = (figure.get("figure_index", 0) or 0) + 1

            base += f"""Analyze this SPECIFIC extracted figure from the paper:

FIGURE: Fig. {fig_idx} (page {fig_page}) from {fig_paper}
DESCRIPTION: {fig_desc}
CLAIM IT SUPPORTS: {fig_claim}

Write a post that directly discusses what this figure shows, what it means, and why it matters.
Your analysis must be about THIS figure — do not reference figures you haven't seen.

JSON format:
{{
  "post_type": "figure",
  "content": "Your analysis of this specific figure (2-3 sentences, reference what the figure shows)",
  "paper_ref": "{fig_paper}"
}}"""
        else:
            base += """Reference a specific figure or table from the retrieved content.

JSON format:
{
  "post_type": "figure",
  "content": "Your analysis of the figure (2-3 sentences)",
  "paper_ref": "Author et al. YEAR"
}"""

    return base


def plan_feed_posts(
    num_posts: int = 12,
    enabled_personas: set[str] | None = None,
    custom_weights: dict[str, float] | None = None,
) -> list[dict[str, str]]:
    """Plan the sequence of posts for a feed generation.

    Returns a list of {persona, post_type} assignments that create
    a natural-feeling discourse timeline.
    """
    persona_keys = [k for k in PERSONAS if not enabled_personas or k in enabled_personas]
    if not persona_keys:
        persona_keys = list(PERSONAS.keys())

    weights_map = custom_weights or POST_TYPE_WEIGHTS
    post_types = list(weights_map.keys())
    weights = list(weights_map.values())

    plan: list[dict[str, str]] = []

    # First few posts should be standalone to establish context
    openers = random.sample(persona_keys, min(3, len(persona_keys)))
    for pk in openers:
        plan.append({"persona": pk, "post_type": "post"})

    # Fill remaining with weighted random selection
    remaining = num_posts - len(plan)
    for _ in range(remaining):
        persona = random.choice(persona_keys)
        post_type = random.choices(post_types, weights=weights, k=1)[0]
        plan.append({"persona": persona, "post_type": post_type})

    return plan
