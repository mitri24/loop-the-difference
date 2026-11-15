import { createPortal } from 'react-dom'
import { AnalysisPartView, useAnalysisWorkbench, type AnalysisPart } from './AnalysisWorkbench'

type Options = Parameters<typeof useAnalysisWorkbench>[0]

// One analysis state for the whole page, its parts rendered into the sections they belong to
// (Coverage, Brightness & spectrum, Aligned analysis, Sky layers). Remount with a new key for a new
// target, detector or field: searches and jobs then start fresh.
export function AnalysisHost({ slots, ...options }: Options & { slots: Partial<Record<AnalysisPart, HTMLElement | null>> }) {
  const wb = useAnalysisWorkbench(options)
  return (
    <>
      {(Object.entries(slots) as [AnalysisPart, HTMLElement | null][]).map(([part, element]) =>
        element ? createPortal(<AnalysisPartView wb={wb} part={part} />, element, part) : null)}
    </>
  )
}
