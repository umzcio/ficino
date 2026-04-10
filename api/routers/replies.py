"""Post reply endpoints — user ↔ persona conversations."""

import json

import asyncpg
import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import settings
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/replies", tags=["replies"])

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"


class ReplyRequest(BaseModel):
    feed_id: str
    post_index: int
    persona_key: str
    user_message: str
    post_content: str
    paper_ref: str | None = None


@router.get("/{feed_id}/{post_index}")
async def get_replies(
    feed_id: str,
    post_index: int,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Get the conversation thread for a specific post."""
    row = await db.fetchrow(
        "SELECT id, messages, persona_key FROM post_replies WHERE feed_id = $1 AND post_index = $2",
        feed_id, post_index,
    )
    if not row:
        return {"messages": [], "persona_key": None}

    messages = row["messages"]
    if isinstance(messages, str):
        messages = json.loads(messages)
    return {"id": str(row["id"]), "messages": messages, "persona_key": row["persona_key"]}


@router.post("")
async def create_reply(
    body: ReplyRequest,
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, object]:
    """Send a reply to a persona and get their response.

    The persona responds grounded in the original post context.
    Conversation history is maintained for multi-turn.
    """
    # Get existing conversation or start new
    row = await db.fetchrow(
        "SELECT id, messages FROM post_replies WHERE feed_id = $1 AND post_index = $2",
        body.feed_id, body.post_index,
    )

    existing_messages: list[dict[str, str]] = []
    reply_id = None
    if row:
        reply_id = str(row["id"])
        existing_messages = row["messages"]
        if isinstance(existing_messages, str):
            existing_messages = json.loads(existing_messages)

    # Add user message
    existing_messages.append({"role": "user", "content": body.user_message})

    # Get persona system prompt from DB
    persona_prompt = await db.fetchval(
        "SELECT system_prompt FROM personas WHERE key = $1 AND is_active = true",
        body.persona_key,
    )
    if not persona_prompt:
        persona_prompt = f"You are {body.persona_key}"

    # Get relevant chunks for context
    chunks_text = ""
    if body.paper_ref:
        chunks = await db.fetch(
            """SELECT c.content, c.section FROM chunks c
               JOIN papers p ON c.paper_id = p.id
               WHERE (p.title ILIKE $1 OR p.filename ILIKE $1)
               ORDER BY c.chunk_index LIMIT 5""",
            f"%{body.paper_ref.split(' et al')[0] if ' et al' in body.paper_ref else body.paper_ref[:30]}%",
        )
        if chunks:
            chunks_text = "\n\n".join(f"[{c['section']}] {c['content']}" for c in chunks)

    # Build conversation for LLM
    system = f"""{persona_prompt}

You are replying to a user in a conversation about an academic paper. Stay in character.
Be specific, cite the paper when relevant. Keep replies conversational — 2-4 sentences.
Do NOT use JSON formatting. Just respond naturally as your persona.

ORIGINAL POST CONTEXT:
{body.post_content}

{"RELEVANT PAPER CONTENT:" + chr(10) + chunks_text if chunks_text else ""}"""

    llm_messages = []
    for msg in existing_messages:
        llm_messages.append({
            "role": "user" if msg["role"] == "user" else "assistant",
            "content": msg["content"],
        })

    # Call LLM
    try:
        if settings.llm_provider == "ollama":
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{settings.ollama_base_url}/api/chat",
                    json={
                        "model": settings.ollama_llm_model,
                        "messages": [
                            {"role": "system", "content": system},
                            *llm_messages,
                        ],
                        "stream": False,
                        "think": False,
                        "options": {"temperature": 0.7, "num_predict": 512},
                    },
                )
                resp.raise_for_status()
                persona_response = resp.json()["message"]["content"]
                if not persona_response and resp.json()["message"].get("thinking"):
                    persona_response = resp.json()["message"]["thinking"]
        else:
            import anthropic
            client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
            resp = await client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=512,
                system=system,
                messages=llm_messages,
            )
            persona_response = resp.content[0].text

    except Exception as e:
        logger.error("reply_generation_failed", error=str(e))
        raise HTTPException(status_code=500, detail="Failed to generate persona response")

    # Add persona response
    existing_messages.append({"role": "persona", "content": persona_response})

    # Store
    messages_json = json.dumps(existing_messages)
    if reply_id:
        await db.execute(
            "UPDATE post_replies SET messages = $1, updated_at = NOW() WHERE id = $2",
            messages_json, reply_id,
        )
    else:
        row = await db.fetchrow(
            """INSERT INTO post_replies (feed_id, post_index, persona_key, messages)
               VALUES ($1, $2, $3, $4) RETURNING id""",
            body.feed_id, body.post_index, body.persona_key, messages_json,
        )
        reply_id = str(row["id"])

    logger.info("reply_generated", persona=body.persona_key, turns=len(existing_messages))

    return {
        "id": reply_id,
        "messages": existing_messages,
        "latest_response": persona_response,
    }
