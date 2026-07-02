"""Worker unit-test fixtures.

These are pure unit tests: DB and provider calls are monkeypatched at the
importing module's namespace (worker modules do `from lib.db import fetch`,
so patch e.g. `tasks.ingestion_tasks.fetch`, not `lib.db.fetch`).

Run inside the worker container:

    docker exec ficino-worker sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"
"""
import os

# Set BEFORE any worker import: lib.storage builds its backend at import
# time and the local backend creates its directories.
os.environ.setdefault("UPLOAD_DIR", "/tmp/ficino-test-uploads")
os.environ.setdefault("FIGURES_DIR", "/tmp/ficino-test-figures")
os.environ.setdefault("DATABASE_URL", "postgresql://ficino:ficino@postgres:5432/ficino")
os.environ.setdefault("REDIS_URL", "redis://redis:6379/0")
