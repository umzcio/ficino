"""Celery application configuration for Ficino workers."""

import os

from celery import Celery

app = Celery(
    "ficino",
    broker=os.getenv("REDIS_URL", "redis://redis:6379/0"),
    backend=os.getenv("REDIS_URL", "redis://redis:6379/0"),
)

app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    # Explicit knobs so we're not relying on Celery defaults. Concurrency
    # can also be set via CELERY_WORKER_CONCURRENCY env (see .env); defaults
    # to CPU count if unset. broker_pool_limit caps Redis connections per
    # worker process — the default (10) is fine but set explicitly to
    # document intent.
    worker_concurrency=int(os.getenv("CELERY_WORKER_CONCURRENCY", "2")),
    worker_max_tasks_per_child=100,
    broker_pool_limit=10,
    # Hard/soft task time limits. A stuck LLM call (Ollama hung on a cold
    # model load, Claude waiting on rate limits, etc.) used to hold a worker
    # slot indefinitely — worker_concurrency=2 means two stuck tasks freeze
    # all Celery work. Soft limit raises SoftTimeLimitExceeded inside the
    # task for graceful cleanup; hard limit SIGKILLs after an extra minute.
    task_soft_time_limit=int(os.getenv("CELERY_SOFT_TIME_LIMIT", "540")),
    task_time_limit=int(os.getenv("CELERY_TIME_LIMIT", "600")),
    task_routes={
        "tasks.ingestion_tasks.*": {"queue": "ingestion"},
        "tasks.persona_tasks.*": {"queue": "persona"},
        "tasks.summary_tasks.*": {"queue": "persona"},
        "tasks.alert_tasks.*": {"queue": "persona"},
        "tasks.preference_tasks.*": {"queue": "persona"},
        "tasks.archivist_tasks.*": {"queue": "persona"},
        "tasks.reading_list_tasks.*": {"queue": "persona"},
    },
)

app.conf.update(
    include=["tasks.ingestion_tasks", "tasks.persona_tasks", "tasks.summary_tasks", "tasks.alert_tasks", "tasks.preference_tasks", "tasks.archivist_tasks", "tasks.reading_list_tasks"],
)
