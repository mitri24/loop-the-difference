# SkyShift

**See how the sky shifts.** Enter a sky position and SkyShift plays NASA SPHEREx images of that patch over time, aligned and on one brightness scale, so moving and changing objects stand out.

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

## Development

- Backend with live reload is the default (`docker-compose.override.yml`); API docs at http://localhost:8000/docs
- Frontend with hot reload: `cd frontend && npm ci && npm run dev` → http://localhost:5173
- Checks: see `CLAUDE.md`, they also run in CI on every push and pull request.

## Data and credits

SPHEREx data: NASA/IPAC Infrared Science Archive (IRSA), Caltech/IPAC. Sky context: Aladin Lite, CDS Strasbourg. Target names: Sesame, CDS. SkyShift is a discovery aid – every change it shows needs checking before it counts as a candidate.
