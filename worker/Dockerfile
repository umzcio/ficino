# Build context = repo root (compose + Railway both build this file with
# context "."). The shared/ package is installed before the service code
# so its layer caches independently.
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/ ./shared/
RUN pip install --no-cache-dir ./shared

COPY worker/ .

CMD ["sh", "-c", "celery -A celery_app worker -B --loglevel=info --queues=ingestion,persona --concurrency=${CELERY_WORKER_CONCURRENCY:-2}"]
