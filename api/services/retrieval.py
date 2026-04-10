"""RAG retrieval service using pgvector hybrid search."""


async def retrieve_chunks(query: str, corpus_id: str, top_k: int = 20) -> list[dict[str, object]]:
    """Retrieve top-k relevant chunks via hybrid vector + BM25 search."""
    raise NotImplementedError("TODO: implement hybrid search")
