# Build context = repo root (compose + Railway both build this file with
# context "."). The shared/ package is installed before the service code
# so its layer caches independently.
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/ ./shared/
RUN pip install --no-cache-dir ./shared

COPY api/ .

EXPOSE 8000

# PORT is injected by Railway's runtime; docker-compose sets nothing and
# falls back to 8000.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
