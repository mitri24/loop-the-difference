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
browser ──► web (nginx + React, Aladin Lite) ──► catalogue layers: VizieR, SIMBAD, SkyBoT
              │ /api                                    │ /analysis
              ▼                                         ▼
            api (FastAPI) ──► redis queue ──► worker(s)  analysis (FastAPI)
                                                │              │
                                                ▼              ▼
                     NASA/IPAC IRSA · SPHEREx releases, AllWISE, CatWISE2020
                     ESA Gaia DR3 · NASA/JPL SBIdent + Horizons · CADC (NEOSSat)
```

1. The API searches IRSA for every SPHEREx observation of the position.
2. A worker downloads small cutouts, spread over all epochs, and resamples them onto one north-up grid.
3. All frames get one shared brightness stretch and are cached, so a target is prepared only once.
4. The worker finds every source in the frames (Photutils) and labels it with its Gaia DR3 or AllWISE match, or as needing verification.

The analysis service (`analysis-service/`, served under `/analysis`) is a second, independent pipeline for the same comparison: its own inverse-variance visit stacks, comparability checks, PSF-matched significance maps (ZOGY) with the SPHEREx ePSF, and context checks against Gaia DR3 and CatWISE2020. The app shows its results as a second method next to the main pipeline.

Scale the heavy part with more workers: `docker compose up --scale worker=4`. Spectra run on a worker of their own (`worker-slow`, queue `slow`), so they never delay a frame job. A new SPHEREx data release needs no change: the search covers every SPHEREx image release IRSA lists (DR1, QR3, their deep fields); `SKYSHIFT_SPHEREX_COLLECTION` is only the fallback while IRSA cannot list them.

## Warm the cache for the demo

The demo must not depend on IRSA answering quickly. This prepares the frames, the epoch stacks and their difference images for the challenge targets (default view, detectors D6 and D1) and keeps the observation search and name-resolution answers on disk, so a demo click is served from the cache even without network:

```sh
docker compose run --rm worker python -m app.warm            # all targets, skips what is complete
docker compose run --rm worker python -m app.warm --dry-run  # list the jobs, no network
docker compose run --rm worker python -m app.warm --targets polaris,wise0855
```

On the server, prefix the same `-f` compose files you deploy with. The command exits non-zero if a target failed or is incomplete, so it doubles as a smoke test after a deploy; re-run it until every frame job reports `cached`. **Re-run it with `--force` after every change to the frame pipeline** (`backend/app/frames.py`, `tasks.py`, `archive.py`), otherwise the cache keeps serving the old rendering. `--force` also refreshes the cached search and name-resolution answers. Each target's quick-look spectrum is measured on every run (it lives in the worker job, not on disk), which downloads its ~100 cutouts once (about 7 s for Barnard's Star once the cutouts are cached); its line never says `cached`, and `--no-spectrum` skips it.

Copy the warmed cache (Docker volume `skyshift_cache`) to the other laptop or the server:

```sh
docker run --rm -v skyshift_cache:/data -v "$PWD":/backup alpine tar czf /backup/cache.tgz -C /data .
# ...move cache.tgz over, then on the target machine:
docker run --rm -v skyshift_cache:/data -v "$PWD":/backup alpine tar xzf /backup/cache.tgz -C /data
```

## Development

- Backend with live reload is the default (`docker-compose.override.yml`); API docs at http://localhost:8000/docs
- Frontend with hot reload: `cd frontend && npm ci && npm run dev` → http://localhost:5173
- Browser tests against the running stack: `cd frontend && npm run test:e2e`. They use the installed Chrome on macOS; elsewhere run `npx playwright install chromium` once, or point `CHROME_PATH` at a Chrome. `SKYSHIFT_BASE_URL` tests another address (default http://localhost:8080).
- Analysis service tests (offline): `docker compose run --rm --no-deps analysis pytest -q`
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

Redeploy after a change, then warm the cache for the demo targets:

```sh
git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm worker python -m app.warm
```

Logs:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f caddy api worker worker-slow
```

## Data and credits

Loop the Difference is a discovery aid – every change it shows is a candidate that needs checking against the catalogues before it counts as anything. It never claims a discovery.

- **SPHEREx images** – NASA/IPAC Infrared Science Archive (IRSA), via the IRSA SIA2 search and cutout services. "This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration." – "This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the National Aeronautics and Space Administration and operated by the California Institute of Technology." [SPHEREx at IRSA](https://irsa.ipac.caltech.edu/Missions/spherex.html) · [IRSA acknowledgements](https://irsa.ipac.caltech.edu/ack.html)
- **Sky context** – [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/), developed at CDS, Strasbourg Observatory, France (Boch & Fernique 2014; Baumann et al. 2022), LGPL-3.0-or-later. Target names are resolved with Sesame (CDS). The sky layers (SPHEREx DR1 all-sky, AllWISE, 2MASS and DSS2 colour) are HiPS surveys from NASA/IPAC IRSA, which mirrors the CDS surveys.
- **AllWISE** (sky layer, catalogue layer, matches of detected sources) – "This publication makes use of data products from the Wide-field Infrared Survey Explorer, which is a joint project of the University of California, Los Angeles, and the Jet Propulsion Laboratory/California Institute of Technology, funded by the National Aeronautics and Space Administration."
- **CatWISE2020** (motions of red sources in the analysis service) – catalogue from WISE and NEOWISE data (Marocco et al. 2021, ApJS 253, 8), via NASA/IPAC IRSA.
- **2MASS sky layer** – "This publication makes use of data products from the Two Micron All Sky Survey, which is a joint project of the University of Massachusetts and the Infrared Processing and Analysis Center/California Institute of Technology, funded by the National Aeronautics and Space Administration and the National Science Foundation."
- **1950 photographic plate and DSS2 layer** – "The Digitized Sky Surveys were produced at the Space Telescope Science Institute under U.S. Government grant NAG W-2166; POSS-I: National Geographic Society – Palomar Observatory." [STScI DSS](https://archive.stsci.edu/cgi-bin/dss_form)
- **ESA Gaia DR3** (proper motions, catalogue layer at the frame date, matches of detected sources) – "This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia Multilateral Agreement."
- **SIMBAD and VizieR** (catalogue layers, through the mirrors at the Harvard-Smithsonian CfA) – "This research has made use of the SIMBAD database and the VizieR catalogue access tool, CDS, Strasbourg Observatory, France."
- **Known asteroids and comets** – SkyBoT (IMCCE, Observatoire de Paris; Berthier et al. 2006) and the NASA/JPL Solar System Dynamics Small-Body Identification API (SBIdent). JPL Horizons gives SPHEREx's own position, so known bodies are placed as SPHEREx saw them.
- **NEOSSat and other telescopes at this position** (Canadian Space Agency, CADC) – observations of the same field from the Canadian Astronomy Data Centre; Hubble and Webb previews in that list come from the Mikulski Archive for Space Telescopes (MAST) at STScI. "This research used the facilities of the Canadian Astronomy Data Centre operated by the National Research Council of Canada with the support of the Canadian Space Agency."
- **Cross-check links** – [WiseView](http://byw.tools/wiseview) (Backyard Worlds), the IRSA Viewer ([Firefly](https://github.com/Caltech-IPAC/firefly)) and the full SPHEREx Level-2 files in the AWS Open Data bucket `nasa-irsa-spherex`.
- **Software** – [Astropy](https://www.astropy.org/) (Astropy Collaboration 2013, 2018, 2022), [reproject](https://reproject.readthedocs.io/) for the alignment, [Photutils](https://photutils.readthedocs.io/) (Bradley et al.) for source detection and photometry, NumPy, SciPy, FastAPI, RQ, React and Vite. PSF-matched differences follow ZOGY (Zackay, Ofek & Gal-Yam 2016, ApJ 830, 27).

## Use of AI

The code in this repository was written with AI coding assistants under human review: Claude Code (Anthropic) for most of it, and OpenAI Codex, which brought in the analysis service (`analysis-service/`) and the analysis workbench (`frontend/src/analysis/`) from our earlier prototype, itself built with AI coding assistants. The team wrote the tickets, decided the architecture and reviewed the changes. Texts in this README and in the app were drafted the same way and reviewed by the team. There are no AI-generated images, audio or video in the project; the demo video is produced by the team.

## License

Loop the Difference is free software under the [GNU General Public License v3.0](LICENSE). The data stay under the terms of their archives (NASA/IPAC IRSA, ESA, CDS, IMCCE, NASA/JPL, CADC, STScI/MAST); Aladin Lite is LGPL-3.0-or-later.
