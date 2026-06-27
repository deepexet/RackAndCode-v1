# ── Stage 1: Build frontend ───────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --prefer-offline

COPY frontend/ ./
RUN npm run build


# ── Stage 2: Python runtime ───────────────────────────────────────────────
FROM python:3.12-slim AS runtime

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY server/ ./server/
COPY backend/ ./backend/

# Built frontend assets
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Migrations
COPY server/migrations/ ./server/migrations/

# Data directory (mounted as volume in production)
RUN mkdir -p /data

# Non-root user
RUN useradd -m -u 1000 rackpilot && chown -R rackpilot:rackpilot /app /data
USER rackpilot

EXPOSE 4173

ENV PYTHONPATH=/app
ENV DB_PATH=/data/fieldos.db
ENV HOST=0.0.0.0
ENV PORT=4173

CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "4173", "--workers", "2"]
