"""One-time script to backfill metadata for existing papers."""

from lib.metadata_extractor import extract_metadata_sync
from lib.db import fetch, execute


def main() -> None:
    papers = fetch("SELECT id, title FROM papers WHERE title IS NULL AND status = 'complete'")
    print(f"Papers to backfill: {len(papers)}")

    for paper in papers:
        pid = str(paper["id"])
        print(f"\nProcessing {pid}...")

        rows = fetch(
            "SELECT content FROM chunks WHERE paper_id = $1 ORDER BY chunk_index LIMIT 5",
            pid,
        )
        if not rows:
            print("  No chunks found, skipping")
            continue

        text = "\n".join(r["content"] for r in rows)
        meta = extract_metadata_sync(text)
        print(f"  Extracted: {meta}")

        sets: list[str] = []
        args: list[object] = []
        idx = 1
        if meta.get("title"):
            sets.append(f"title = ${idx}")
            args.append(meta["title"])
            idx += 1
        if meta.get("authors"):
            sets.append(f"authors = ${idx}")
            args.append(meta["authors"])
            idx += 1
        if meta.get("year"):
            sets.append(f"year = ${idx}")
            args.append(meta["year"])
            idx += 1
        if meta.get("doi"):
            sets.append(f"doi = ${idx}")
            args.append(meta["doi"])
            idx += 1

        if sets:
            args.append(pid)
            execute(f"UPDATE papers SET {', '.join(sets)} WHERE id = ${idx}", *args)
            print("  Updated!")
        else:
            print("  No metadata extracted")


if __name__ == "__main__":
    main()
