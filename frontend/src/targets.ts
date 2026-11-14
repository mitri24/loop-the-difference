import type { TargetQuery } from './url'

// Wavelength ranges per detector, taken from the SPHEREx DR1 archive metadata.
export const DETECTORS = [
  { band: 1, label: 'D1 · 0.75–1.12 µm' },
  { band: 2, label: 'D2 · 1.10–1.65 µm' },
  { band: 3, label: 'D3 · 1.63–2.43 µm' },
  { band: 4, label: 'D4 · 2.40–3.85 µm' },
  { band: 5, label: 'D5 · 3.81–4.43 µm' },
  { band: 6, label: 'D6 · 4.41–5.01 µm' },
]

export const FIELDS_OF_VIEW = [0.1, 0.2, 0.4]

// band and fov, when set, replace the detector and region size of the current view.
export type ChallengeTarget = { label: string; hint?: string; band?: number; fov?: number }
  & ({ name: string } | { ra: string; dec: string })

// Test targets named in the NASA Space Apps 2026 challenge, plus Polaris as the start view and Pluto
// at its 2026 SPHEREx position (fixed coordinates: name resolution would give today's position).
export const CHALLENGE_TARGETS: ChallengeTarget[] = [
  { label: 'Polaris', ra: '02:31:49.09', dec: '+89:15:50.8' },
  { label: 'WISE 0855', ra: '08h55m10.831s', dec: '-7d14m42.53s' },
  { label: "Barnard's Star", name: "Barnard's Star" },
  { label: 'Epsilon Indi B', name: 'eps Ind B' },
  { label: 'RW Aurigae', name: 'RW Aur' },
  { label: 'R Draconis', name: 'R Dra' },
  { label: 'Pluto · known dwarf planet (2026)', hint: 'an example with a known moving object',
    ra: '308.5364', dec: '-22.9153', band: 1, fov: 0.2 },
]

export function presetView(target: ChallengeTarget, draft: TargetQuery): TargetQuery {
  return { ...draft, band: target.band ?? draft.band, fov: target.fov ?? draft.fov }
}
