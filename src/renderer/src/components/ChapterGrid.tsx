import type React from 'react'

interface ChapterGridProps {
  total: number
  done: number
  active?: number | null
}

export function ChapterGrid({ total, done, active }: ChapterGridProps): React.JSX.Element | null {
  if (!total || total <= 0) {
    return <p className="muted">Chapter count not decided yet.</p>
  }
  const cells = Array.from({ length: total }, (_, i) => i + 1)
  return (
    <div className="chapter-grid" role="img" aria-label={`${done} of ${total} chapters written`}>
      {cells.map((n) => {
        const state =
          n <= done ? 'done' : active != null && n === active ? 'active' : 'todo'
        return <span key={n} className={`chapter-cell chapter-${state}`} title={`Chapter ${n}`} />
      })}
    </div>
  )
}
