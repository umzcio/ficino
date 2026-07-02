"""Single Celery client for API-side dispatch (R10 API-5).

Module-level so hot polling paths don't construct a new app + broker
connection per request. Configured with broker AND result backend —
papers.py's old inline copy omitted the backend (drift)."""
from celery import Celery

from config import settings

celery_app = Celery(broker=settings.redis_url, backend=settings.redis_url)


def get_celery() -> Celery:
    return celery_app
