FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv
WORKDIR /app/backend
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project
COPY app ./app
COPY tests ./tests
ENV PATH="/app/backend/.venv/bin:$PATH" SPHEREX_CACHE_DIR=/data/cache PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
