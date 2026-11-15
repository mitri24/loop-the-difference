# Observation gallery — 15 November 2026

## What changed
`src/components/BlinkPlayer.tsx` now provides an image contact sheet for every loaded frame, alongside the existing blink controls and metadata. `src/styles.css` bounds horizontal scrolling to the contact sheet. No API, image processing, map adapter, or calibration contracts changed.

## User flow
Open a region comparison → Exposures or Stacks → scroll the Observations image strip → click a preview to inspect it. Set A / Set B assigns comparison slots and enables Blink A↔B. Selecting a preview pauses playback and enters the all-frames mode. A frame cannot fill both comparison slots.

## Feature parity
| Operation | Result / evidence |
|---|---|
| Previous/next, play/pause, speed, keyboard shortcuts | Existing controls retained; live E2E exercises playback and next |
| A/B timestamp dropdowns, source links, detector and wavelength metadata | Retained; gallery adds direct assignment; contact-sheet E2E checks assignment and duplicate prevention |
| Direct image selection | Added; E2E checks click, Enter and selected state |
| Map, layers, Gaia marker, candidate marks, spectrum, sharing | Existing integration code retained; full-suite results recorded separately |
| Real images | Existing frame URLs used directly; synthetic images only in contract tests |

## Responsive and accessibility QA
Contact-sheet E2E passed at widths 320, 375, 390, 600, 768, 1024, 1280, 1366, 1440 and 1920 (height 768). It checks selection, A/B assignment, disabled duplicate assignment, Enter activation and no global horizontal overflow. Screenshots: `/private/tmp/skyshift-gallery-results/`. Desktop and 320px screenshots visually inspected. Focus styles, native buttons, pressed states, labelled scroll region and timestamps included. Existing reduced-motion behavior retained.

## Science and limitations
The screenshot's A and B identify selected observations, not a detection or confidence rating. Dates, detector, wavelength and source identifiers come from the existing manifest. Thumbnails use the same image URLs as the main viewer; no fabricated astronomical images are introduced. The strip displays the loaded frames, not a claim of complete archive coverage. Live SPHEREx comparison E2E passed (real images, source links, playback and map tools). No moderated usability study was performed. A complete independent science/calibration audit is outside this contact-sheet change.

## Checks
Typecheck, lint, production build and 210 unit tests passed. New ten-width contact-sheet browser test passed. Live SPHEREx E2E passed. Full E2E suite: 37/37 passed in 2.5 minutes, including live API and real SPHEREx imagery; artifacts in `/private/tmp/skyshift-gallery-full/`. Existing viewport tests cover heights 600, 700, 768 and 900 plus zoom reflow, touch/rotation and reduced motion. No known blocker in the tested gallery flow.

## Follow-up: consistent centring
Removed the wide-screen split between image and A/B metadata. The main image stays square and centred on the viewer in both A/B and all-frames mode; metadata sits below. Short preview strips centre when they fit. Each thumbnail now marks the same field centre and the gallery states RA/Dec, field width and north-up orientation. Image pixels are unchanged; the existing backend `target_grid` / `align` already reprojects all frames to one sky grid. This does not centre each frame's brightest source or establish source-level registration accuracy in real observations.

Validation: build, typecheck and lint passed; the contact-sheet test now checks square image dimensions and horizontal centring in both modes across ten widths. It passed, as did the real SPHEREx E2E test. Screenshots in `/private/tmp/skyshift-centred-results/`. Updated assets copied to the local Docker web app. This follow-up did not rerun the entire 37-test suite.

## Follow-up: compact list to the left of the selected image
The observation player now places a 280px scrollable list to the left of the large square image when its content area is at least 640px wide. Preview images are 84px square. Every list entry keeps its timestamp, effective wavelength/detector, coverage, epoch, release (per-frame value when available), exposure count and source link visible without opening it; stacked date ranges are included. A/B selection remains on each entry. On narrow screens the same list follows the image vertically.

Validation: build, lint and typecheck passed. The updated ten-width contact-sheet E2E passed (preview size, left placement, square/centred selected image, per-image metadata, click/keyboard selection, A/B assignment, no document horizontal overflow). Desktop screenshot inspected in `/private/tmp/skyshift-left-gallery-retest/`. Real SPHEREx E2E also passed in `/private/tmp/skyshift-left-gallery/`. The initial fixture run failed because the test's broad `**/api/**` interception also caught `/src/analysis/api/client.ts`; the route now matches API path prefixes only. No science pipeline changes.

## Follow-up: reference graphs first in the menu
The Observations and Spectrum menu panels now lead with the imported SPHEREX reference charts (date versus wavelength and aperture spectrum with error bars, band colours and visit shapes). They were already integrated but appeared after the older tools. Desktop panels now provide at least 620px where viewport space permits. Existing timeline and quick-look spectrum remain reachable below. The selected target and 0.2-degree field are passed to the analysis as 12 arcmin.

Validation: production build, lint and 215 unit tests passed. Reference-graph E2E passed using exact URL coordinates 269.640817 / 4.910194, verifying request parameters, chart-first ordering, graph width and mobile overflow. Existing analysis flow E2E also passed (sequence, difference, observations, spectrum). Both chart screenshots visually inspected in `/private/tmp/skyshift-reference-graphs-retest/`. Fixture data are test-only. A live archive request initially timed out after 60 seconds; the repeat timed out after 120 seconds as well. The local analysis health endpoint returned status ok, so live chart population for this exact region could not be verified during this run. UI flow and target wiring were verified with explicitly synthetic browser fixtures. No synthetic astronomical measurements ship with this change. Local assets updated on port 8080.
