# API service only. Model serving runs in the separate `vllm` container so the
# GPU image (~10GB) is not rebuilt every time application code changes.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts

RUN useradd --create-home --uid 10001 app && chown -R app:app /srv
USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

# Single worker: requests are I/O-bound on the model server and the research
# MCP, and asyncio handles the concurrency. Scale by raising CLAIM_CONCURRENCY
# rather than by forking workers that would contend for the same GPU.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
