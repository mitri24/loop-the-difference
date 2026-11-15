# Menu and algorithm integration — 2026-11-15

## What changed

Integrated the side-centred menu arrangement from the user's local app at port 5180 into the existing SkyShift app at port 8080. Existing menus and the main image comparison remain. The labelled desktop rail is centred vertically, bounded by viewport height and scrollable when necessary; phones keep the accessible horizontal bottom menu. The rail reserves layout space so it does not cover Aladin attribution or map controls.

`src/App.tsx` adds Blink, Difference and Observations and extends Spectrum, Evidence, Layers and About. `src/analysis/` contains the reference components, a target/epoch adapter, protected job polling, locally scoped reference styles and the analysis workbench. `analysis-service/` contains the real reference Python algorithms and tests. nginx routes only `/analysis/` to this service; the existing `/api/` contract stays intact. No iframe, substitute website or runtime dependency on port 5180 is used.

## User flow

Open the existing Barnard URL → choose Blink in the centred rail → choose Same wavelength, Visit stacks, or All exposures → Build aligned sequence → inspect real aligned frames and FITS/source links. Open Difference to reuse that sequence, select A/B, calculate the difference or significance map and inspect residuals. Optional JPL vetting is an explicit job. Observations shows coverage history plus the time/wavelength plot and CADC context. Spectrum keeps the existing quick-look tool and adds aperture photometry. Evidence groups additional pipeline checks alongside the original checks.

The current target, detector and field are adapted to the reference API. Degrees are explicitly converted to arcminutes (analysis supports 2–30′). When Gaia proper motion is supplied, its reference coordinates and epoch travel together; coordinates from one epoch are never paired with another epoch. Metadata searches occur on opening an analysis; image downloads require a Build/Measure action. A new target/detector/field creates a fresh analysis context. Closing panels preserves the shared sequence and current main-viewer state. New blink playback starts paused.

## Feature parity matrix

| Existing / reference feature | Integrated placement | Status |
| --- | --- | --- |
| Target and options | Existing Target | Preserved |
| Main exposures/stacks/difference | Existing large viewer and modes | Preserved |
| Candidate marks, track, known objects | Existing Candidate | Preserved |
| Data links, provenance, sharing, embed | Existing Data/header/embed | Preserved |
| Reference aligned blink and matched wavelength / stacked / all algorithms | New Blink | Real imported pipeline, shared target |
| Reference pairwise differences, significance, residual vetting | New Difference | Real imported pipeline, shared aligned sequence |
| Reference JPL residual vetting | Difference, explicit optional job | Imported, upstream availability not guaranteed |
| Original quick-look spectrum | Existing Spectrum | Preserved |
| Reference aperture spectrum, error bars, log flux, quality encoding | Spectrum, additional section | Real imported pipeline |
| Original timeline and accessible table | Observations + existing history button | Preserved |
| Reference time–wavelength plot and archive queries | Observations | Imported |
| Reference CADC / NEOSSat context | Observations | Imported; remains context, never mixed into SPHEREx differences |
| Original checks | Existing Evidence | Preserved |
| Reference search/sequence/difference/spectrum checks | Evidence plus analysis outputs | Integrated |
| Original surveys, cube wavelength, catalogues, native tools | Existing Layers / Aladin | Preserved |
| Reference aligned FITS overlay | Blink, Show on sky | Scoped layer; old frame/source overlays yield while it is shown |
| Reference exposure footprints | Layers, additional section | Real IRSA polygons for selected detector |
| Original credits | Existing About | Preserved |
| Reference release refresh | About, Check for new SPHEREx data now | Imported real endpoint |

## Provisional UX assumptions

The primary job is comparing observations; additional algorithms should be discoverable from the same menu and should not duplicate the application shell. Keep familiar labels and existing functions, share the target, and show computed results before setup controls. These are expert design assumptions; no participant research or population usability metrics were collected.

## Responsive/accessibility QA

New integration tests cover all 10 actions at widths 320, 375, 390, 600, 768, 1024, 1280, 1366, 1440 and 1920, at 600/900px heights. They check desktop rail centring, panel close visibility, focus return, no page horizontal overflow, and menu preservation. A fixture flow verifies target/band/field/matched-mode requests, sequence reuse, significance map selection, time/wavelength chart, CADC entry, aperture spectrum and original Candidate/Data. Separate service-error coverage verifies retry and access to Data.

Imported component styles and image colour tokens are scoped to `.reference-analysis`; they cannot restyle the existing map, navigation or original scientific visuals. Charts retain semantic tables; colour is supplemented by detector labels, marker shape or status words. Blink is paused by default and slows under reduced motion. Difference blink is explicit. Images retain UTC, wavelength, coverage, source and FITS metadata. Desktop and mobile screenshots are reviewed; simulated fixture images are test-only, never shipped as science data.

## Limitations and remaining checks

The two pipelines have different scientific/data contracts and remain separately identified; no claim is made that their stacks or measurements are interchangeable. Upstream outages, in-memory reference job expiry, PSF mismatch, aperture correction and noise systematics remain as described in `analysis-service/README.md`. Optional JPL, CADC, full-spectrum downloads, real touch/virtual-keyboard and participant testing require separate evidence; offline tests alone do not certify their current live availability.

## Executed validation and known live issue

- TypeScript, ESLint, production build: PASS.
- Frontend unit tests: 215 passed.
- Imported backend offline suite: 84 passed, 6 network tests deselected.
- Existing workspace browser suite: all 35 passed.
- New menu/algorithm/error integration suite: all 3 passed, including 10 widths × 2 heights. Final visual refinements were followed by a targeted rerun.
- Live health and Barnard name resolution: PASS against the actual analysis service.
- Live end-to-end pipeline: NOT VERIFIED. First metadata request exceeded the test's 90-second deadline. With 180 seconds allowed, the archive search returned zero observations after upstream request timeouts; frame/difference assertions were therefore never reached. Direct IRSA queries with both default and explicit VOTable formats also timed out at 20 seconds. This is not evidence of absent sky coverage. The UI now explicitly labels incomplete archive searches, shows individual checks and offers Retry archive search.
- Optional live JPL/CADC, full-spectrum measurements and overlay FITS loading are not certified by the mocked browser fixtures.

Remaining release concern: live IRSA retrieval must recover before a real-data demonstration of the additional pipeline can be certified. The original comparison and menu remain independently usable. This change does not claim a new object detection.
