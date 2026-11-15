# Image comparison UX — 15 November 2026

Scope: the running Docker application is built from `SkyShift-wt/demo`. Applied the user-provided `planet-x-senior-ux/SKILL.md` from the Desktop ZIP. No astronomy data pipeline or third-party integration was replaced.

## Problem and design

User evidence: the supplied screenshots and feedback describe dense, cramped comparison metadata, unclear warnings, and a need to mark several objects. No additional participant research was conducted.

Primary job: choose single or combined images, select two moments, mark an object in both, then investigate it. Separate objects must never feed one combined movement calculation.

The comparison panel now has three stages: choose images, compare two moments, your objects. Image options use plain names and retain Exposures/Stacks in their explanation. Time, wavelength and image composition remain visible. Quality, detections, exact timestamps and archive provenance are under Image details & original data. Larger controls and spacing replace the earlier dense overrides. The sky workspace and contained panel scrolling remain intact.

Image checks now name the impact on brightness comparison, explain why colour can mimic brightness change, and retain the existing compatible-pair action. Flagged pixels explain defects and checking other images. Calibration notes explain processing differences. General context is folded; blockers and cautions remain visible. Raw check details and source documentation stay available.

Each object has its own two marks and verdict. Object buttons show mark counts; adding and switching preserves other objects. Image and sky markers use numbered labels (1A, 1B, 2A...). Clear affects the selected object only. Motion, known-object checks and export run for the selected object. Shared URLs carry all objects, including multiple positions in the same observation; legacy two-mark URLs remain compatible. Object verdicts retain the existing behavior: exported in the selected object's JSON, but not encoded in URLs. There is no application-imposed object count limit, including grouped shared links.

## Feature parity and tested flow

| Feature | Placement and preservation | Evidence |
| --- | --- | --- |
| Single/combined images | Same mode action, clearer names | Browser hit targets at ten widths |
| A/B selection, swap, playback, swipe | Existing player and handlers | Workspace browser suite |
| Timestamp, wavelength, image composition | Comparison table; exact time in details | Component tests |
| Quality, sources, release, archive links | Expand image details | Component tests; original API untouched |
| Mark in image / detected source / sky | Same handlers per selected object | Candidate browser flow |
| Multiple objects and clear | Object buttons above marking action | Two objects, same frame, switch, clear browser regression |
| Shared marks | Existing URL plus grouped object marks | URL unit tests and browser reload |
| Known-object checks / possible track / verdict | Selected object's original pipeline | Existing component and scientific unit tests |
| Download | Selected object's existing evidence export; link includes all objects | Export browser test |
| Warnings, raw details and recovery | Image checks, context disclosures | Component and responsive browser tests |
| Search, layers, Aladin controls, fullscreen, keyboard | Existing workspace | Workspace browser suite; live verification separate |

Tested object flow: open a comparison → expand Detected sources → mark a source → next frame → mark again → Add object → mark another source → reload → switch objects → clear the second object's marks → first object's pair remains. Image clicking and sky marking use the same selected object.

## Verification and limits

Unit/type/lint/build commands: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
Browser command: `SKYSHIFT_BASE_URL=http://127.0.0.1:4173 npm run test:e2e -- workspace.spec.ts`.
The suite uses explicitly synthetic API fixtures to verify interactions; these are never production observations. New screenshots cover image choices and checks at 320, 375, 390, 600, 768, 1024, 1280, 1366, 1440 and 1920 px. Existing bounds checks also cover heights 600/700/768/900 and keyboard/touch behavior. Playwright output lives in `frontend/test-results` and `frontend/playwright-report`.

Scientific provenance: actual observations continue to come from the existing SPHEREx/IRSA pipeline. No new release claims, source matches, detections or calibration rules were introduced. Different light bands still block the same difference operation. An object marked by the user remains unverified. The real local API and live SPHEREx image workflow were separately tested successfully (2 live tests); the analysis pipeline live test was skipped by its existing environment gate. Actual browser 200%/400% zoom, a screen-reader session and a new participant usability test remain NOT VERIFIED. The workspace suite covers equivalent smaller CSS viewports for zoom reflow.

Final command outcomes and remaining issues are appended after QA.


## Final results

- TypeScript: PASS. ESLint: PASS. Production build: PASS. Git whitespace check: PASS.
- Unit/component tests: 341 PASS across 55 files.
- Workspace browser suite: 51 PASS. Following the final difference-disclosure refinement, all three affected browser flows were rerun: 3 PASS.
- Live local services: 2 PASS, 1 unrelated analysis live test skipped by its existing opt-in gate.
- Local web container rebuilt successfully; the updated application is served at http://localhost:8080.
- No known P0/P1 issue found in the tested scope. Remaining verification gaps are the human usability/accessibility checks stated above; no claim of exhaustive accessibility certification.
- Selected-object export remains per object; the link in the export restores the full marked-object collection. A different comparison clears the collection, preserving the earlier comparison-local behavior.

Screenshots (synthetic UI fixtures, not discovery evidence):
[Desktop images](comparison-images-desktop.png), [mobile images](comparison-images-mobile.png),
[desktop checks](comparison-checks-desktop.png), [mobile checks](comparison-checks-mobile.png).

Follow-up: removed object-count caps from the add action and grouped URL serialization/parsing; round-trip regression covers 125 objects / 250 marks. A/B headers now always stack the badge and frame choice identically, preventing asymmetric wrapping.

Follow-up QA: 341 unit tests, typecheck, lint and build PASS. Three affected browser flows PASS, including A/B alignment across ten widths and 26 added objects. Local container check beyond 20 objects PASS. One earlier check was interrupted by the container restart; it passed on retry after startup.

Menu/export follow-up: inspector uses the same bordered, orange-selected segmented style as the image toggle, with equal columns and responsive wrapping. Export is labelled Export evidence (JSON), with guidance to use Share for reopening or sharing. Five affected browser checks PASS, including export readback, keyboard and ten-width checks. Typecheck, lint, 341 component tests and production build PASS.

Compact-menu correction: retained segmented appearance while restoring a single compact row with 30px controls. Narrow rails scroll internally rather than increasing header height. Five responsive/short-height browser checks and production build PASS; local container updated.
