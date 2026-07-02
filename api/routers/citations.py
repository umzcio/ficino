"""Citation generation — formatted academic citations from paper metadata."""

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException

from auth import AuthUser, get_current_user
from db.connection import get_db

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/citations", tags=["citations"])


def _format_apa(title: str, authors: list[str], year: int | None, doi: str | None) -> str:
    """Format an APA 7th edition citation."""
    if not authors or (len(authors) == 1 and authors[0].lower() in ("unknown", "")):
        author_str = "Unknown Author"
    elif len(authors) == 1:
        parts = authors[0].split()
        author_str = f"{parts[-1]}, {'. '.join(p[0] for p in parts[:-1])}." if len(parts) > 1 else authors[0]
    elif len(authors) == 2:
        a1 = authors[0].split()
        a2 = authors[1].split()
        a1_str = f"{a1[-1]}, {'. '.join(p[0] for p in a1[:-1])}." if len(a1) > 1 else authors[0]
        a2_str = f"{a2[-1]}, {'. '.join(p[0] for p in a2[:-1])}." if len(a2) > 1 else authors[1]
        author_str = f"{a1_str}, & {a2_str}"
    else:
        # R10 API-11: build `formatted` from ALL authors, not just the
        # first 19 — the previous `authors[:19]` slice meant `formatted[-1]`
        # was always the 19th author, never the paper's true last author.
        # That silently dropped author #20 in the exactly-20 case (APA 7
        # requires listing all 20) and cited the wrong "last author" (#19
        # instead of the true final one) in the 21+ case.
        formatted = []
        for a in authors:
            parts = a.split()
            formatted.append(f"{parts[-1]}, {'. '.join(p[0] for p in parts[:-1])}." if len(parts) > 1 else a)
        if len(authors) > 20:
            # APA 7: first 19, ellipsis, then the true final author.
            author_str = ", ".join(formatted[:19]) + ", ... " + formatted[-1]
        else:
            # <=20 authors: list everyone, joining the last with '&'.
            author_str = ", ".join(formatted[:-1]) + ", & " + formatted[-1]

    year_str = f"({year})" if year else "(n.d.)"
    doi_str = f" https://doi.org/{doi}" if doi else ""
    return f"{author_str} {year_str}. {title}.{doi_str}"


def _format_mla(title: str, authors: list[str], year: int | None, doi: str | None) -> str:
    """Format an MLA 9th edition citation."""
    if not authors or (len(authors) == 1 and authors[0].lower() in ("unknown", "")):
        author_str = ""
    elif len(authors) == 1:
        parts = authors[0].split()
        author_str = f"{parts[-1]}, {' '.join(parts[:-1])}" if len(parts) > 1 else authors[0]
    elif len(authors) == 2:
        p1 = authors[0].split()
        author_str = f"{p1[-1]}, {' '.join(p1[:-1])}, and {authors[1]}" if len(p1) > 1 else f"{authors[0]}, and {authors[1]}"
    else:
        p1 = authors[0].split()
        author_str = f"{p1[-1]}, {' '.join(p1[:-1])}, et al." if len(p1) > 1 else f"{authors[0]}, et al."

    year_str = str(year) if year else ""
    doi_str = f" https://doi.org/{doi}." if doi else ""
    if author_str:
        return f'{author_str}. "{title}." {year_str}.{doi_str}'
    return f'"{title}." {year_str}.{doi_str}'


@router.get("/by-title")
async def cite_by_title(
    title: str,
    format: str = "apa",
    user: AuthUser = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """Generate a formatted citation by paper title (fuzzy match)."""
    row = await db.fetchrow(
        "SELECT title, authors, year, doi FROM papers WHERE user_id = $2 AND title ILIKE $1 LIMIT 1",
        f"%{title[:80]}%", user.id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper_title = row["title"] or title
    authors = row["authors"] or []
    year = row["year"]
    doi = row["doi"]

    if format == "mla":
        citation = _format_mla(paper_title, authors, year, doi)
    else:
        citation = _format_apa(paper_title, authors, year, doi)

    return {"citation": citation, "format": format, "title": paper_title}
