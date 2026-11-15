# Observation history redesign — 2026-11-15

## What changed
The permanently expanded, full-width bottom timeline is replaced by an on-demand Observation history panel. Its trigger is next to the comparison modes in `src/App.tsx`. The panel uses the existing resizable desktop panel and mobile sheet, preserving Escape dismissal, focus return, and comparison state. `src/styles/shell.css` adds compact observation/epoch/detector metadata and a readable chart sized to the panel. On narrow screens the overview map yields space while a detail sheet is open; closing the sheet restores it.

## User flow and design assumptions
Load a target → compare images → Observation history → inspect real date spacing, detectors and current-frame marker → Escape or Close → resume the same frame. The main job is comparing observations; coverage history is contextual evidence. This placement is a design hypothesis, not a finding from participant research. No participant session or analytics collection was performed.

## Feature parity
| Existing feature | Placement after change | Verification |
| --- | --- | --- |
| Observation timeline, six detectors, epochs, frame and current markers | History panel | Browser visibility and screenshots; rendering/data code retained |
| Accessible observation and frame tables | History panel | Existing semantic table retained |
| Time axis, UTC dates, stacked date spans | Same component and helpers | Existing unit tests |
| Resize timeline | Uses existing panel width / mobile sheet height handles | Existing panel interaction tests |
| Fold timeline | Close panel / Escape, focus returns to History | New browser test |
| Comparison modes, playback, frame choice, provenance | Existing viewer | Existing fixture browser suite |
| Search, retry, cancellation, sharing and embed | Existing entry points | Existing fixture browser suite |
| Aladin, map controls, layers, candidate, evidence, spectrum, data, about | Existing UI | Existing workspace suite; live remote services not comprehensively revalidated |

## Responsive/accessibility QA
New history test covers widths 320, 375, 390, 600, 768, 1024, 1280, 1366, 1440 and 1920 at heights 600, 700, 768 and 900. It verifies the trigger fits and is clickable, the panel fits, Close is clickable, no page horizontal overflow, Escape returns focus, and the selected comparison frame is retained. Screenshots are generated at 390 and 1440 widths. Existing tests additionally cover keyboard, reduced motion, touch rotation and zoom-equivalent reflow. Zoom-equivalent viewports are not a physical browser zoom or real virtual-keyboard test.

## Provenance and caveats
No archive queries, imagery, release selection, WCS, comparison logic or science claims were changed. Browser comparison tests use explicitly labeled TEST_FIXTURE data; these prove UI behavior, not live scientific validity. Chart dates continue to come from existing observation/frame metadata. Live upstream availability and scientific comparability were not newly certified. No P0/P1 issue specific to the history change is known after targeted testing; broad product certification and participant usability remain outside this focused change.

## Executed checks
- `npm run typecheck`, `npm run lint`, `npm test` (210/210), and production build passed.
- Full `workspace.spec.ts`: 33 passed; a 1366px run failed during trace-file cleanup (ENOENT), then passed in isolated rerun. The contact-sheet test timed out in the combined run and passed in an isolated rerun (14.5 s including startup). All 35 workspace test cases passed across the combined run and isolated reruns; the combined run itself was not fully green.
- Targeted history flow and 1366px rerun passed against the final mobile layout (`--output=/private/tmp/skyshift-history-qa`).
- Final screenshots: `observation-history-390.png`, `observation-history-1440.png`.
- Local Docker web image rebuilt and restarted on port 8080; no backend changes.
