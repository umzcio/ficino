"""Persona prompt construction and feed generation."""


async def generate_persona_feed(corpus_id: str, tag_filter: list[str] | None = None) -> str:
    """Queue persona feed generation. Returns task ID."""
    raise NotImplementedError("TODO: dispatch Celery persona task")
