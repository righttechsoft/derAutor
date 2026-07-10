import React, { useEffect, useState } from 'react'
import type { ReviewIssueStats } from '@shared/domain'
import { useStore, useSelectedProject } from '../store'
import { TopBar } from '../components/TopBar'
import { StageStepper } from '../components/StageStepper'
import { ChapterGrid } from '../components/ChapterGrid'
import { StatusBadge } from '../components/Badges'
import { ConfirmDialog } from '../components/Modal'
import { fmtCost, fmtInt, pct } from '../format'

function ReviewCard({ stats }: { stats: ReviewIssueStats[] }): React.JSX.Element {
  const latest = stats.length ? stats[stats.length - 1] : null
  return (
    <div className="card panel">
      <h3 className="panel-title">Review</h3>
      {!latest ? (
        <p className="muted">Review hasn’t started yet.</p>
      ) : (
        <>
          <div className="review-summary">
            <div className="stat">
              <span className="stat-value">{latest.round}</span>
              <span className="stat-label">round</span>
            </div>
            <div className="stat">
              <span className="stat-value">{latest.open}</span>
              <span className="stat-label">open issues</span>
            </div>
            <div className="stat">
              <span className="stat-value">{latest.total}</span>
              <span className="stat-label">found total</span>
            </div>
          </div>
          <div className="review-breakdown">
            <div>
              <span className="breakdown-head">By severity</span>
              <div className="chip-row">
                {Object.entries(latest.bySeverity).length === 0 && <span className="muted">—</span>}
                {Object.entries(latest.bySeverity).map(([k, v]) => (
                  <span key={k} className={`count-chip sev-${k.toLowerCase()}`}>
                    {k} {v}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <span className="breakdown-head">By category</span>
              <div className="chip-row">
                {Object.entries(latest.byCategory).length === 0 && <span className="muted">—</span>}
                {Object.entries(latest.byCategory).map(([k, v]) => (
                  <span key={k} className="count-chip">
                    {k} {v}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ActivityCard({ entries }: { entries: { at: string; line: string }[] }): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])
  return (
    <div className="card panel">
      <h3 className="panel-title">Activity</h3>
      {entries.length === 0 ? (
        <p className="muted">Live step-by-step log appears here while the pipeline runs.</p>
      ) : (
        <div className="activity-feed" ref={scrollRef}>
          {entries.map((e, i) => (
            <div key={`${e.at}-${i}`} className="activity-line">
              <span className="activity-time">
                {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span>{e.line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ProgressDashboard(): React.JSX.Element {
  const project = useSelectedProject()
  const progress = useStore((s) => (project ? s.progress[project.id] : undefined))
  const liveCost = useStore((s) => (project ? s.liveCost[project.id] : undefined))
  const costSummary = useStore((s) => s.costSummary)
  const reviewStats = useStore((s) => s.reviewStats)
  const errorMsg = useStore((s) => (project ? s.errors[project.id] : undefined))
  const activity = useStore((s) => (project ? s.activity[project.id] : undefined))
  const loadDashboard = useStore((s) => s.loadDashboard)
  const startProject = useStore((s) => s.startProject)
  const setIllustrations = useStore((s) => s.setIllustrations)
  const settings = useStore((s) => s.settings)
  const pauseProject = useStore((s) => s.pauseProject)
  const cancelProject = useStore((s) => s.cancelProject)
  const setScreen = useStore((s) => s.setScreen)
  const goHome = useStore((s) => s.goHome)

  const [confirmCancel, setConfirmCancel] = useState(false)

  // Rolling pace tracker: first time we see each chapter number in the current
  // stage, remember when — the average gap gives a live ETA.
  const paceRef = React.useRef<{ stage: string; chapter: number; t: number }[]>([])
  useEffect(() => {
    if (!progress || progress.chapter == null) return
    const hist = paceRef.current
    const last = hist[hist.length - 1]
    if (last && last.stage !== progress.stage) hist.length = 0
    if (!hist.length || hist[hist.length - 1].chapter !== progress.chapter) {
      hist.push({ stage: progress.stage, chapter: progress.chapter, t: Date.now() })
      if (hist.length > 10) hist.shift()
    }
  }, [progress])

  let etaMinutes: number | null = null
  if (
    progress &&
    progress.chapter != null &&
    progress.ofChapters &&
    (progress.stage === 'chapters' || progress.stage === 'illustrate')
  ) {
    const hist = paceRef.current
    if (hist.length >= 2) {
      const first = hist[0]
      const last = hist[hist.length - 1]
      const chapterSpan = last.chapter - first.chapter
      if (chapterSpan > 0) {
        const perChapterMs = (last.t - first.t) / chapterSpan
        const remaining = progress.ofChapters - progress.chapter + 1
        etaMinutes = Math.max(1, Math.round((perChapterMs * remaining) / 60_000))
      }
    }
  }

  const projectId = project?.id
  useEffect(() => {
    if (projectId) void loadDashboard(projectId)
  }, [projectId, loadDashboard])

  if (!project) {
    return (
      <div className="screen">
        <TopBar title="Progress" onBack={() => void goHome()} />
        <div className="screen-body">
          <p className="muted">No project selected.</p>
        </div>
      </div>
    )
  }

  const cost = liveCost ?? costSummary?.costUsd ?? project.costUsd
  const words = progress?.wordsWritten ?? project.wordsWritten
  const percent = pct(words, project.targetWords)
  const activeChapter = progress?.chapter ?? null
  const chapterCount = project.chapterCount ?? 0
  const bannerError = errorMsg ?? project.error

  const isRunning = project.status === 'running'
  const isDone = project.stage === 'done' || project.status === 'done'
  const canStart = !isRunning && !isDone

  return (
    <div className="screen">
      <TopBar
        title={project.title}
        subtitle="In progress — spoiler-free"
        onBack={() => void goHome()}
        right={<StatusBadge status={project.status} />}
      />

      <div className="screen-body">
        {bannerError && <div className="banner banner-error">{bannerError}</div>}

        {isDone && (
          <div className="banner banner-ready done-banner">
            <span>Your book is finished.</span>
            <button className="btn btn-success btn-sm" onClick={() => setScreen('export')}>
              Open export
            </button>
          </div>
        )}

        <div className="card panel">
          <StageStepper
            current={project.stage}
            illustrations={project.illustrations}
            isTranslation={project.isTranslation}
          />
          {progress?.message && (
            <p className="progress-line">
              {progress.message}
              {etaMinutes != null && (
                <span className="muted"> — ≈{etaMinutes} min remaining in this stage</span>
              )}
            </p>
          )}
        </div>

        <div className="dash-grid">
          <div className="card panel">
            <h3 className="panel-title">Chapters</h3>
            <ChapterGrid total={chapterCount} done={project.chaptersDone} active={activeChapter} />
            <p className="panel-foot muted">
              {project.chaptersDone}
              {chapterCount ? ` / ${chapterCount}` : ''} chapters written
            </p>
          </div>

          <div className="card panel">
            <h3 className="panel-title">Words</h3>
            <div className="big-metric">{fmtInt(words)}</div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="panel-foot muted">
              {percent}% of {fmtInt(project.targetWords)} target
            </p>
          </div>

          <div className="card panel">
            <h3 className="panel-title">Cost</h3>
            <div className="big-metric cost-metric">{fmtCost(cost)}</div>
            {costSummary && (
              <p className="panel-foot muted">
                {fmtInt(costSummary.calls)} calls · {fmtInt(costSummary.outputTokens)} output tokens
              </p>
            )}
          </div>
        </div>

        <ReviewCard stats={reviewStats} />

        <ActivityCard entries={activity ?? []} />

        {project.stage !== 'done' && !project.isTranslation && (
          <div className="card panel export-card">
            <div>
              <h3 className="panel-title">Illustrations</h3>
              <p className="muted">
                {project.illustrations
                  ? 'On — a style-locked cover and one image per chapter will be painted after the review.'
                  : 'Off — the book will be text only. You can turn this on any time before the book is finished.'}
              </p>
              {project.illustrations && settings && !settings.openaiKeySet && (
                <p className="muted" style={{ color: 'var(--amber)' }}>
                  Add your OpenAI API key in Settings before this stage starts.
                </p>
              )}
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => void setIllustrations(project.id, !project.illustrations)}
            >
              {project.illustrations ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        )}

        <div className="controls">
          {canStart && (
            <button className="btn btn-primary" onClick={() => void startProject(project.id)}>
              {project.status === 'paused' ? 'Resume' : 'Start'}
            </button>
          )}
          {isRunning && (
            <button className="btn btn-ghost" onClick={() => void pauseProject(project.id)}>
              Pause
            </button>
          )}
          {(isRunning || project.status === 'paused') && (
            <button className="btn btn-danger" onClick={() => setConfirmCancel(true)}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this book?"
          message="Generation will stop. You can resume later from where it left off, but the current step will be discarded."
          confirmLabel="Cancel book"
          cancelLabel="Keep going"
          danger
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => {
            void cancelProject(project.id)
            setConfirmCancel(false)
          }}
        />
      )}
    </div>
  )
}
