# SkyShift – notes for AI assistants

NASA Space Apps 2026, challenge "Planet X and SPHEREx": a public web tool. RA/Dec in → SPHEREx images of that patch over time as a blink → moving and changing objects stand out. A discovery aid: never claim discoveries.

## Architecture
- `frontend/` React + Vite + TypeScript, Aladin Lite for sky context; nginx serves it and proxies `/api` to the API.
- `backend/` FastAPI (`app/main.py`) and an RQ worker (`app/worker.py`, job in `app/tasks.py`) on Redis; frames and cutouts are cached in the shared volume `/data/cache`.
- Data: IRSA SIA2, collection from `SKYSHIFT_SPHEREX_COLLECTION` (default `spherex_dr1`; `spherex_qr3` returns nothing). Cutouts: `access_url?center=<ra>,<dec>&size=<deg>`; IRSA answers `503 Server busy` under load, so downloads retry.
- `frontend/src/types.ts` mirrors `backend/app/models.py`: change both together.

## Commands (Docker is the only requirement, on every OS)
- Run everything: `docker compose up --build` → http://localhost:8080, API docs http://localhost:8000/docs
- Backend checks: `docker compose run --rm --no-deps api sh -c "ruff format --check . && ruff check . && pytest"`
- Frontend: `cd frontend && npm ci`, then `npm run dev` (proxies to :8000), `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
- After backend changes restart the worker: `docker compose restart worker` (the API reloads by itself)

## Rules
- Science honesty: label changes as candidates that need checking; keep provenance (obs_id, cutout URL, date, detector) for every frame shown.
- Compare only comparable data: same detector, warn about epochs, coverage and wavelength.
- One rule in one place: coordinates are parsed only in `backend/app/coords.py`.
- Downloads and image processing run in the worker, never inside a request.
- Tests never touch the network; use fixtures in `backend/tests/fixtures`.
- Cross-OS: Docker and npm scripts only, no shell-specific scripts.
