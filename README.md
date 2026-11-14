# Loop the Difference

**See how the sky shifts.** Enter a sky position and Loop the Difference plays NASA SPHEREx images of that patch over time, aligned and on one brightness scale, so moving and changing objects stand out.

Built for the NASA Space Apps Challenge 2026 – [Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/).

## Run it

Requirement: [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS, Windows, Linux).

```sh
docker compose up --build
```

Open http://localhost:8080 – or link straight to a target, e.g. the fast-moving brown dwarf WISE 0855:
http://localhost:8080/?ra=08h55m10.831s&dec=-7d14m42.53s&fov=0.2&band=6

## How it works

```
browser ──► web (nginx + React, Aladin Lite)
              │ /api
              ▼
            api (FastAPI) ──► redis queue ──► worker(s)
                                                │ search (SIA2) + cutouts
                                                ▼
                                   NASA/IPAC IRSA · SPHEREx DR1
```

1. The API searches IRSA for every SPHEREx observation of the position.
2. A worker downloads small cutouts, spread over all epochs, and resamples them onto one north-up grid.
3. All frames get one shared brightness stretch and are cached, so a target is prepared only once.

Scale the heavy part with more workers: `docker compose up --scale worker=4`. A new SPHEREx data release is one setting: `SKYSHIFT_SPHEREX_COLLECTION` (see `.env.example`).

## Warm the cache for the demo

The demo must not depend on IRSA answering quickly. This prepares the frames for the six challenge targets (default view, detectors D6 and D1) and keeps the observation search and name-resolution answers on disk, so a demo click is served from the cache even without network:

```sh
docker compose run --rm worker python -m app.warm            # all targets, skips what is complete
docker compose run --rm worker python -m app.warm --dry-run  # list the jobs, no network
docker compose run --rm worker python -m app.warm --targets polaris,wise0855
```

On the server, prefix the same `-f` compose files you deploy with. The command exits non-zero if a target failed or is incomplete, so it doubles as a smoke test after a deploy; re-run it until everything reports `cached`. **Re-run it with `--force` after every change to the frame pipeline** (`backend/app/frames.py`, `tasks.py`, `archive.py`), otherwise the cache keeps serving the old rendering. `--force` also refreshes the cached search and name-resolution answers.

Copy the warmed cache (Docker volume `skyshift_cache`) to the other laptop or the server:

```sh
docker run --rm -v skyshift_cache:/data -v "$PWD":/backup alpine tar czf /backup/cache.tgz -C /data .
# ...move cache.tgz over, then on the target machine:
docker run --rm -v skyshift_cache:/data -v "$PWD":/backup alpine tar xzf /backup/cache.tgz -C /data
```

## Development

- Backend with live reload is the default (`docker-compose.override.yml`); API docs at http://localhost:8000/docs
- Frontend with hot reload: `cd frontend && npm ci && npm run dev` → http://localhost:5173
- Checks: see `CLAUDE.md`, they also run in CI on every push and pull request.

## Deploy

Production runs the same stack behind [Caddy](https://caddyserver.com/), which gets and renews the HTTPS certificate by itself.

Prerequisites on the server: Docker with the Compose plugin (≥ 2.24), ports 80 and 443 open, and a DNS A record for your domain pointing at the server **before** the first start. While the repository is private, clone it with a read-only deploy key that lives only on the server – never in the repository.

First start:

```sh
git clone <repository-url> loop-the-difference && cd loop-the-difference
cp .env.example .env            # set DOMAIN=your.domain
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Redeploy after a change, then warm the cache for the demo targets (`app.warm` arrives with the cache-warming step; skip that part until it exists):

```sh
git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm worker python -m app.warm
```

Logs:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f caddy api worker
```

## Data and credits

SPHEREx data: NASA/IPAC Infrared Science Archive (IRSA), Caltech/IPAC. Sky context: Aladin Lite, CDS Strasbourg. Target names: Sesame, CDS. Loop the Difference is a discovery aid – every change it shows needs checking before it counts as a candidate.
