# Compact image browser — 2026-11-15

The selected image has a compact vertical thumbnail rail on its LEFT, aligned with the image's top edge. The rail is bounded by the image height and scrolls internally. The selected image's metadata sits on the right on wide screens and below it in a bounded section on narrow screens. Main and aligned-reference image browsers follow the same arrangement.

Selection, stepping, and ↑/↓/Home/End thumbnail navigation update the large image and metadata from the same frame. Selecting a thumbnail pauses playback. Existing playback, A/B choices, overlays, flags, source links and downloads remain available. Per-thumbnail repeated metadata was moved to the selected-image inspector. The aligned-image panel opens wider but retains its functional resize handle and separate saved width.

Metadata retains UTC, visit/epoch, wavelength, exposures, release, coverage, flags, noise, PSF, sources and FITS links where provided by that pipeline. Extra grid/processing metadata is available on demand. Unknown fields are explicitly not reported. All source files are reachable; long source lists are disclosed instead of permanently expanding the page. No images, observations, measurements, or algorithms were changed by this layout work.

Files: `src/components/BlinkPlayer.tsx`, `src/analysis/components/BlinkPlayer.tsx`, `src/components/FloatingPanel.tsx`, `src/App.tsx`, `src/styles/shell.css`, `src/analysis/integration.css`.

Tests cover selected-frame metadata/FITS synchronization, keyboard selection, thumbnail position and height, panel resizing, and no horizontal page overflow. Main-view tests inspect widths 320–1920; aligned-view tests inspect desktop and phone. Screenshots are synthetic UI fixtures, not scientific results. Participant usability, real-device virtual keyboards and upstream archive availability are not newly certified.

Validation: TypeScript, lint, 215 unit tests and production build passed. Final targeted browser tests passed for both viewers (12.0 s), including exact left position, equal top edge and image-bounded rail height, metadata synchronization and functional panel resize. A broader run passed 37/40 cases; one navigation failed during a local container restart, and two existing search/keyboard cases use selectors/validation expectations from the previous search toolbar. That broader run is not reported as fully green. No upstream archive revalidation was needed for this UI-only change; existing IRSA availability caveats remain.
