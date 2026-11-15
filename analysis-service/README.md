# Integrated SPHEREx analysis engine

Imported from the user's local `Downloads/SPHEREX/backend` reference (the app on port 5180), 2026-11-15. This is an additional service for SkyShift; it does not replace the existing API, workers, candidate workflow, image comparison or provenance.

## Run and test

- `docker compose up -d --build analysis web` from the SkyShift project.
- `docker compose run --rm --no-deps analysis pytest -q` — offline science/API regression suite.
- UI: existing app on port 8080; API: `/analysis/api/…` through nginx.
- No runtime dependency on port 5180 or on files outside this repository.

A single Uvicorn process owns the imported pipeline's in-memory jobs/frame registry. Downloaded cutouts and rendered images persist in the `analysis-cache` Docker volume. After a service restart, rebuild a sequence before differencing its frames. The original SkyShift cache and workers are independent.

## Imported algorithms and outputs

- Discover IRSA collections; search footprints and group visits.
- Estimate wavelength at the target from detector footprints and stored WCS-WAVE tables; remeasure after downloading.
- Propagate catalogue coordinates from their stated epoch using proper motion.
- Align real cutouts on one TAN grid; mask hard flags; inverse-variance visit stacks.
- Select matched-wavelength visits, or explicitly use all varying-wavelength exposures.
- Pairwise comparability checks, subpixel registration and photometric scaling.
- A−B residual/significance maps, empirical noise rescaling, and |S|>5 local maxima.
- Context checks against Gaia and AllWISE; optional JPL asteroid/comet job.
- PSF-matched significance (ZOGY) with the SPHEREx ePSF; without an ePSF, the direct A−B significance.
- Aperture spectrum with variance errors and quality flags, corrected to total flux with the ePSF.
- CADC context archive search and release discovery/refresh.

Scientific routines and their tests were copied together. Do not confuse the original comparison's frames with this service's separately aligned sequence. Differences are candidates for verification; ePSF model errors and local noise/significance systematics remain. Remote services can be slow or unavailable; their warnings remain visible.

Python 3.12 is used so the frozen dependency lock includes Linux ARM wheels for photutils. `uv sync --frozen` installs the exact locked versions. See frontend/docs/menu-integration-ux.md for interaction QA and the feature mapping.
