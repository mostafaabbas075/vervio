# syntax=docker/dockerfile:1

FROM python:3.12-slim AS builder
WORKDIR /build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1

COPY pyproject.toml ./
COPY app ./app
RUN python -m pip install --prefix=/install --no-cache-dir .

FROM python:3.12-slim AS runner
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

RUN groupadd --system vervio && useradd --system --gid vervio --home-dir /app vervio

COPY --from=builder /install /usr/local
COPY --from=builder --chown=vervio:vervio /build/app ./app
COPY --chown=vervio:vervio alembic ./alembic
COPY --chown=vervio:vervio alembic.ini pyproject.toml ./

USER vervio
EXPOSE 8000

# One worker intentionally owns each long-lived Gemini Live WebSocket session.
# The hosting platform supplies PORT at runtime; no migrations run at container startup.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1"]
