import type { FrameJob } from '../types'
import '../styles/load-progress.css'

interface Props {
  busy: boolean
  job: FrameJob | null
}

// The loading bar on the dividing line under the viewer head: how many of the requested SPHEREx images the
// worker has fetched. Until it knows how many it will fetch, the bar only moves; once loaded, it is gone.
export function LoadProgress({ busy, job }: Props) {
  if (!busy) return null
  const total = job?.total ?? 0
  const done = Math.min(job?.progress ?? 0, total)
  const text = total > 0 ? `${done} of ${total} images loaded` : 'Loading SPHEREx images'
  const state = total === 0 ? ' searching' : done === total ? ' finishing' : ''
  return (
    <div className={`load-progress${state}`} role="progressbar" aria-label="SPHEREx images" aria-valuetext={text} title={text}
      {...(total > 0 ? { 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done } : {})}>
      <span style={total > 0 ? { width: `${(done / total) * 100}%` } : undefined} />
    </div>
  )
}
