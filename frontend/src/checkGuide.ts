import type { Check, CheckSeverity, FrameManifest } from './types'

// Quality feedback in plain words. Every check answers what was checked (its title, phrased as the result),
// why it matters and what to do; the backend's message and detail stay available as technical details.

// From what stops a comparison to what only informs.
export type CheckKind = 'blocking' | 'fixable' | 'limit' | 'info'
export const KIND_ORDER: CheckKind[] = ['blocking', 'fixable', 'limit', 'info']
export const KIND_TITLE: Record<CheckKind, string> = {
  blocking: 'Needs your attention',
  fixable: 'Can be fixed',
  limit: 'Keep in mind',
  info: 'About these images',
}
export const SEVERITY_ORDER: CheckSeverity[] = ['error', 'blocker', 'warning', 'info']

// Stable ids the workspace wires to a control.
export type CheckActionId = 'choose-compatible-pair' | 'choose-region' | 'retry'
export interface CheckAction { id: CheckActionId; label: string }

interface Guide {
  kind: CheckKind
  title: (count: number) => string
  text: string
  action?: CheckAction
  // What a feature this check disables needs instead, e.g. the difference.
  requires?: string
  // Shown with this severity's icon and word when the backend's severity would alarm without reason.
  shown?: CheckSeverity
}

const images = (count: number) => (count === 1 ? 'One image' : `${count} images`)
const CHOOSE_REGION: CheckAction = { id: 'choose-region', label: 'Choose another region' }
const RETRY: CheckAction = { id: 'retry', label: 'Retry' }

const GUIDE: Record<string, Guide> = {
  NO_OBSERVATIONS: {
    kind: 'blocking', title: () => 'No usable observations', action: CHOOSE_REGION,
    text: 'SPHEREx has no usable image of this region with this detector. Choose another detector or region.',
    requires: 'Difference needs two usable observations. Choose another detector or region.',
  },
  SINGLE_EPOCH: {
    kind: 'blocking', title: () => 'Insufficient observations', action: CHOOSE_REGION,
    text: 'Only one suitable observation is available, so nothing can be compared over time. Select another region or detector.',
    requires: 'Difference needs two compatible observations; only one is available here. Select another region or detector.',
  },
  NO_TIME_BASELINE: {
    kind: 'blocking', title: () => 'No time baseline', action: CHOOSE_REGION,
    text: 'All usable observations were taken within one epoch, so change over time cannot show. Select a region with repeat coverage.',
    requires: 'Difference needs observations from two epochs; all usable ones here come from one epoch.',
  },
  WAVELENGTH_MISMATCH: {
    kind: 'blocking', title: () => 'Brightness cannot be compared with this pair',
    action: { id: 'choose-compatible-pair', label: 'Find images in the same light band' },
    text: 'These images capture different bands of infrared light. An object can look brighter because of its colour. You can still look for movement; choose the same light band to compare brightness.',
    requires: 'Difference needs two observations at the same wavelength. Choose a compatible pair from the timeline.',
  },
  WAVELENGTH_CLOSE: {
    kind: 'limit', title: () => 'Slightly different wavelengths',
    text: 'The images were observed more than half but at most one spectral resolution element apart. Positions compare directly; a brightness change can still be a spectral feature.',
  },
  PREVIEW: {
    kind: 'info', shown: 'info', title: () => 'Preview',
    text: 'These first images are provisional; final images, source matching and difference checks are still being prepared. Wait until loading finishes.',
    requires: 'Difference is available once the final images are ready.',
  },
  CUTOUT_MISSING: {
    kind: 'fixable', title: (n) => `${images(n)} not delivered`, action: RETRY,
    text: 'The archive did not deliver every requested image, so the blink leaves the missing ones out. Retrying often brings them back.',
  },
  RELEASE_UNAVAILABLE: {
    kind: 'fixable', title: () => 'Release not searched', action: RETRY,
    text: 'An archive did not answer, so observations from that release are missing. Retry to search it again.',
  },
  SOURCES_CATALOG_UNAVAILABLE: {
    kind: 'limit', title: () => 'Catalogue unavailable',
    text: 'A catalogue did not answer in time, so sources it could have matched are labelled unknown. Treat unknown sources as unverified.',
  },
  FLAGGED_PIXELS: {
    kind: 'limit', title: (n) => `Pixels near the target need care · ${images(n).toLowerCase()}`,
    text: 'Some pixels near your target are unreliable. A spot appearing or disappearing there may be an image defect. Check the object in other images before marking it as a change.',
  },
  LOW_OVERLAP: {
    kind: 'limit', title: (n) => `${images(n)} left out`,
    text: 'Some observations cover too little of the region to be aligned with the others, so the blink leaves them out. A smaller region size may keep them in.',
  },
  WAVELENGTH_UNKNOWN: {
    kind: 'limit', title: () => 'Wavelength match unknown',
    text: 'Some images carry no wavelength table, so a brightness change between epochs could be a wavelength effect. Treat brightness changes in the difference with care.',
  },
  MIXED_RELEASES: {
    kind: 'limit', title: () => 'Small brightness shifts may come from processing',
    text: 'These images were processed with different calibrations. Small brightness shifts may come from that processing. Confirm them in images from the same release.',
  },
  DETECTION_LIMIT: {
    kind: 'info', title: () => 'Detection limit measured',
    text: 'Artificial stars of known brightness were added to copies of A and B and searched for to measure which point sources these images can reveal.',
  },
  SOURCES: {
    kind: 'info', title: () => 'Sources matched with catalogues',
    text: 'Sources were detected in every image and compared with Gaia DR3 and AllWISE; unmatched ones need verification.',
  },
}

const EPOCH_CODES = ['NO_OBSERVATIONS', 'SINGLE_EPOCH', 'NO_TIME_BASELINE']

// Too few observations, or a wavelength spread among the first unstacked previews, is provisional while
// images are still loading; too few observations after missing images may change with a retry.
function guideFor(code: string, codes: Set<string>): Guide | undefined {
  const guide = GUIDE[code]
  if (!guide || ![...EPOCH_CODES, 'WAVELENGTH_MISMATCH', 'WAVELENGTH_CLOSE'].includes(code)) return guide
  if (codes.has('PREVIEW')) {
    return { kind: 'fixable', shown: 'warning', title: (n) => `${guide.title(n)} so far`,
      text: 'Only part of the observations has loaded so far, so this may change. Wait until loading finishes.', requires: GUIDE.PREVIEW.requires }
  }
  if (EPOCH_CODES.includes(code) && (codes.has('CUTOUT_MISSING') || codes.has('RELEASE_UNAVAILABLE'))) {
    return { kind: 'fixable', title: guide.title, action: RETRY,
      text: 'Some images or releases did not load, so this may change after a retry. Retry before choosing another region.',
      requires: 'Difference needs two compatible observations, and some did not load. Retry first.' }
  }
  return guide
}

export const CANDIDATE_CAVEAT = {
  title: 'Changes are candidates',
  text: 'A blink shows that something changed, not what it is: wavelength, coverage and image artefacts can mimic a change. Check a candidate against catalogues before calling it anything.',
}

const fallbackKind: Record<CheckSeverity, CheckKind> = { error: 'blocking', blocker: 'blocking', warning: 'fixable', info: 'info' }
const worst = (severities: CheckSeverity[]) => SEVERITY_ORDER.find((s) => severities.includes(s)) ?? 'info'

export interface ExplainedCheck {
  code: string
  severity: CheckSeverity
  title: string
  text: string
  action?: CheckAction
  // The backend's own words (flags, tolerances, obs ids), shown on demand.
  details: string[]
}

// One entry per check code (three flagged frames are one entry), grouped by kind, worst first.
export function explainChecks(checks: Check[]): { kind: CheckKind; items: ExplainedCheck[] }[] {
  const byCode = new Map<string, Check[]>()
  for (const check of checks) byCode.set(check.code, [...(byCode.get(check.code) ?? []), check])
  const codes = new Set(byCode.keys())
  const items = [...byCode.entries()].map(([code, group]) => {
    const guide = guideFor(code, codes)
    const words = group.map((check) => check.detail || check.message).filter(Boolean)
    const severity = worst(group.map((check) => check.severity))
    const item: ExplainedCheck & { kind: CheckKind } = guide
      ? { code, severity: guide.shown ?? severity, kind: guide.kind, title: guide.title(group.length),
        text: guide.text, action: guide.action, details: words }
      // An unknown code speaks in the backend's words; with several, each one's detail stays on demand.
      : { code, severity, kind: fallbackKind[severity], title: group[0].message, text: group[0].detail, details: group.length > 1 ? words : [] }
    return item
  })
  return KIND_ORDER.flatMap((kind) => {
    const inKind = items.filter((item) => item.kind === kind)
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    return inKind.length > 0 ? [{ kind, items: inKind }] : []
  })
}

// What a disabled feature needs, in the words of the check that blocks it.
export function blockedReason(checks: Check[], feature: string): { text: string; action?: CheckAction } | null {
  const codes = new Set(checks.map((check) => check.code))
  const blocking = checks.filter((c) => (c.severity === 'blocker' || c.severity === 'error') && c.affects.includes(feature))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  const [first] = blocking
  if (!first) return null
  const guide = guideFor(first.code, codes)
  return guide?.requires ? { text: guide.requires, action: guide.action } : { text: `${first.message}.` }
}

export interface PassedCheck { code: string; title: string; text: string }

// Checks that ran and found nothing. The pipeline runs coverage, flag, cutout, release, epoch and
// wavelength checks on every final comparison (backend/app/tasks.py _render_frames) and records each
// problem as a check, so a missing problem code means that check passed; the wavelength check only
// covers images whose wavelength is known.
export function passedChecks(manifest: Pick<FrameManifest, 'preview' | 'frames' | 'epochs' | 'release'>, checks: Check[]): PassedCheck[] {
  const n = manifest.frames.length
  if (manifest.preview || n === 0) return []
  const found = new Set(checks.map((check) => check.code))
  const passed: PassedCheck[] = []
  if (n >= 2) {
    passed.push({ code: 'ALIGNED', title: 'Images aligned',
      text: n === 2 ? 'Both observations cover a compatible sky coordinate grid.' : `All ${n} images cover a compatible sky coordinate grid.` })
  }
  if (manifest.epochs >= 2 && !EPOCH_CODES.some((code) => found.has(code))) {
    passed.push({ code: 'EPOCHS', title: 'Enough observations', text: `Observations from ${manifest.epochs} epochs can be compared over time.` })
  }
  const known = manifest.frames.filter((frame) => frame.wavelength_um != null).length
  if (n >= 2 && known === n && !['WAVELENGTH_MISMATCH', 'WAVELENGTH_CLOSE', 'WAVELENGTH_UNKNOWN'].some((code) => found.has(code))) {
    passed.push({ code: 'WAVELENGTH', title: 'Same wavelength',
      text: 'All images were observed within half a spectral resolution element of each other, so they compare directly.' })
  }
  if (!found.has('CUTOUT_MISSING')) passed.push({ code: 'CUTOUTS', title: 'All images delivered', text: 'The archive delivered every requested image.' })
  if (!found.has('FLAGGED_PIXELS')) passed.push({ code: 'FLAGS', title: 'Target pixels usable', text: 'No image has pixels flagged as unusable next to the target.' })
  if (!found.has('RELEASE_UNAVAILABLE') && !found.has('MIXED_RELEASES')) {
    passed.push({ code: 'RELEASES', title: 'One calibration release',
      text: `All images come from ${manifest.release ? `SPHEREx ${manifest.release}` : 'one SPHEREx release'}, and every release could be searched.` })
  }
  return passed
}
