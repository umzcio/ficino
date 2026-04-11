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


@router.get("/conversations")
async def list_conversations(
    db: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, object]]:
    """List all reply conversations with metadata for the inbox."""
    rows = await db.fetch(
        """SELECT pr.id, pr.feed_id, pr.post_index, pr.persona_key,
                  pr.messages, pr.updated_at,
                  f.generated_at AS feed_generated_at
           FROM post_replies pr
           LEFT JOIN feeds f ON pr.feed_id::uuid = f.id
           ORDER BY pr.updated_at DESC"""
    )
    results = []
    for r in rows:
        messages = r["messages"]
        if isinstance(messages, str):
            messages = json.loads(messages)
        # Get last user message as preview
        last_user = ""
        last_persona = ""
        for msg in reversed(messages):
            if msg["role"] == "user" and not last_user:
                last_user = msg["content"][:100]
            elif msg["role"] == "persona" and not last_persona:
                last_persona = msg["content"][:100]
            if last_user and last_persona:
                break
        results.append({
            "id": str(r["id"]),
            "feed_id": r["feed_id"],
            "post_index": r["post_index"],
            "persona_key": r["persona_key"],
            "message_count": len(messages),
            "last_user_message": last_user,
            "last_persona_message": last_persona,
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        })
    return results


@router.get("/replied-posts/{feed_id}")
async def get_replied_post_indices(
    feed_id: str,
    db: asyncpg.Connection = Depends(get_db),
) -> list[int]:
    """Return post indices that have reply conversations for a given feed."""
    rows = await db.fetch(
        "SELECT post_index FROM post_replies WHERE feed_id = $1",
        feed_id,
    )
    return [r["post_index"] for r in rows]


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

    # --- Organic interjection: after 3+ messages, another persona may jump in ---
    interjection = None
    user_turns = sum(1 for m in existing_messages if m["role"] == "user")
    if user_turns >= 2:
        try:
            interjection = await _maybe_interject(
                db, body.persona_key, existing_messages, body.post_content, chunks_text
            )
            if interjection:
                existing_messages.append({
                    "role": "interjection",
                    "persona": interjection["persona_key"],
                    "content": interjection["content"],
                })
                messages_json = json.dumps(existing_messages)
                await db.execute(
                    "UPDATE post_replies SET messages = $1, updated_at = NOW() WHERE id = $2",
                    messages_json, reply_id,
                )
                logger.info("interjection_generated", persona=interjection["persona_key"])
        except Exception as e:
            logger.warn("interjection_failed", error=str(e))

    result: dict[str, object] = {
        "id": reply_id,
        "messages": existing_messages,
        "latest_response": persona_response,
    }
    if interjection:
        result["interjection"] = interjection
    return result


async def _maybe_interject(
    db: asyncpg.Connection,
    current_persona: str,
    messages: list[dict[str, str]],
    post_content: str,
    chunks_text: str,
) -> dict[str, str] | None:
    """Check if another persona should jump into the conversation."""
    import random

    # Get all active personas except the current one
    rows = await db.fetch(
        "SELECT key, name, handle, system_prompt, retrieval_query FROM personas WHERE is_active = true AND key != $1",
        current_persona,
    )
    if not rows:
        return None

    # Build conversation text for topic matching
    convo_text = " ".join(m["content"] for m in messages).lower()

    # Score each persona by how many of their retrieval query terms appear in the conversation
    candidates = []
    for r in rows:
        query_terms = [t.strip().lower() for t in r["retrieval_query"].split(",")]
        hits = sum(1 for t in query_terms if t in convo_text)
        if hits >= 2:
            candidates.append({"row": r, "score": hits})

    if not candidates:
        return None

    # Pick the best match, with some randomness (don't always interject)
    if random.random() > 0.7:
        return None

    candidates.sort(key=lambda c: c["score"], reverse=True)
    chosen = candidates[0]["row"]

    # Build the interjection prompt
    convo_summary = "\n".join(
        f"{'User' if m['role'] == 'user' else m.get('persona', 'Persona')}: {m['content']}"
        for m in messages[-4:]
    )

    interjection_system = f"""{chosen['system_prompt']}

You are jumping into an existing conversation thread between a user and another persona. You saw this thread and couldn't resist weighing in because it touches your area of expertise.

Rules:
- Enter with an opinion, not a neutral observation. You have a take.
- Acknowledge you're jumping in: "Sorry to butt in but..." or "I've been lurking on this thread and..." or "Okay I have to say something here..."
- Keep it to 2-3 sentences. You're interjecting, not taking over.
- Engage with what was ACTUALLY said, don't just restate the paper.
- Do NOT use JSON. Respond naturally.

{"PAPER CONTEXT:" + chr(10) + chunks_text if chunks_text else ""}"""

    interjection_prompt = f"""This conversation is happening on a post about: {post_content[:200]}

Recent thread:
{convo_summary}

Jump in with your perspective as {chosen['name']} ({chosen['handle']})."""

    try:
        if settings.llm_provider == "ollama":
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{settings.ollama_base_url}/api/chat",
                    json={
                        "model": settings.ollama_llm_model,
                        "messages": [
                            {"role": "system", "content": interjection_system},
                            {"role": "user", "content": interjection_prompt},
                        ],
                        "stream": False,
                        "think": False,
                        "options": {"temperature": 0.8, "num_predict": 256},
                    },
                )
                resp.raise_for_status()
                content = resp.json()["message"]["content"]
                if not content and resp.json()["message"].get("thinking"):
                    content = resp.json()["message"]["thinking"]
        else:
            import anthropic
            client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
            resp = await client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=256,
                system=interjection_system,
                messages=[{"role": "user", "content": interjection_prompt}],
            )
            content = resp.content[0].text

        return {
            "persona_key": chosen["key"],
            "name": chosen["name"],
            "handle": chosen["handle"],
            "content": content,
        }
    except Exception as e:
        logger.warn("interjection_llm_failed", error=str(e))
        return None
