"""PDF ingestion orchestration service."""


async def trigger_ingestion(paper_id: str, file_path: str) -> str:
    """Queue a paper for ingestion processing. Returns task ID."""
    raise NotImplementedError("TODO: dispatch Celery ingestion task")
