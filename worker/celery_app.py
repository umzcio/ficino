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
    task_routes={
        "tasks.ingestion_tasks.*": {"queue": "ingestion"},
        "tasks.persona_tasks.*": {"queue": "persona"},
        "tasks.summary_tasks.*": {"queue": "persona"},
        "tasks.alert_tasks.*": {"queue": "persona"},
        "tasks.preference_tasks.*": {"queue": "persona"},
        "tasks.archivist_tasks.*": {"queue": "persona"},
    },
)

app.conf.update(
    include=["tasks.ingestion_tasks", "tasks.persona_tasks", "tasks.summary_tasks", "tasks.alert_tasks", "tasks.preference_tasks", "tasks.archivist_tasks"],
)
