import React, { useEffect, useMemo, useState } from 'react'
import type { NewProjectInput, ProjectSummary } from '@shared/domain'
import { useStore, useSelectedProject } from '../store'
import { familyOf } from '../books'
import { TopBar } from '../components/TopBar'
import { fmtCost, fmtInt, pct } from '../format'
import { BookIcon, LockIcon } from '../components/Icons'

const PRESET_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Russian' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' }
]

/** The finished-book control for spinning up / managing this book's languages. */
function LanguagesCard({ project }: { project: ProjectSummary }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const createProject = useStore((s) => s.createProject)
  const openProject = useStore((s) => s.openProject)
  const exportSaveAs = useStore((s) => s.exportSaveAs)

  const family = useMemo(() => familyOf(projects, project.id), [projects, project.id])
  const root = family?.root ?? project
  const variants = family?.variants ?? [project]
  const existing = new Set(variants.map((v) => v.language.toLowerCase()))
  const choices = PRESET_LANGUAGES.filter((l) => !existing.has(l.code))

  const [target, setTarget] = useState(choices[0]?.code ?? '')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const language = target === 'custom' ? custom.trim() : target
  const canTranslate = language.length > 0 && !existing.has(language.toLowerCase()) && !busy

  async function translate(): Promise<void> {
    if (!canTranslate) return
    setBusy(true)
    setError(null)
    const input: NewProjectInput = {
      title: `${root.title} (${language})`,
      language,
      targetWords: root.targetWords || project.targetWords || 1,
      illustrations: false,
      genreHint: '',
      worldInput: '',
      premiseInput: '',
      sourceProjectId: project.id,
      mode: 'translation'
    }
    try {
      await createProject(input) // navigates to the new translation's screen
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not start the translation.')
    }
  }

  return (
    <div className="card panel">
      <h3 className="panel-title">Languages</h3>
      <div className="variant-list">
        {variants.map((v) => {
          const done = v.stage === 'done' || v.status === 'done'
          return (
            <div key={v.id} className="variant-row">
              <span className="variant-row-lang">
                {v.language.toUpperCase()}
                {v.id === root.id && <span className="muted"> · original</span>}
              </span>
              <span className="muted variant-row-status">
                {done ? 'finished' : v.status === 'running' ? `${pct(v.wordsWritten, v.targetWords)}%` : v.status}
              </span>
              <span className="variant-row-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void openProject(v)}>
                  Open
                </button>
                <button className="btn btn-ghost btn-sm" disabled={!done} onClick={() => void exportSaveAs(v.id)}>
                  Download FB2…
                </button>
              </span>
            </div>
          )
        })}
      </div>

      <div className="translate-row">
        <label className="field">
          <span className="field-label">Translate into a new language</span>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {choices.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label} ({l.code})
              </option>
            ))}
            <option value="custom">Other…</option>
          </select>
        </label>
        {target === 'custom' && (
          <label className="field">
            <span className="field-label">Language code</span>
            <input className="input" value={custom} placeholder="e.g. pt-BR, ko" onChange={(e) => setCustom(e.target.value)} />
          </label>
        )}
        <button className="btn btn-primary" onClick={() => void translate()} disabled={!canTranslate}>
          {busy ? 'Starting…' : 'Translate'}
        </button>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
    </div>
  )
}

function AuthorsRoomGate(): React.JSX.Element {
  const project = useSelectedProject()
  const unlock = useStore((s) => s.unlockAuthorsRoom)
  const openRoom = useStore((s) => s.loadArtifacts)
  const setScreen = useStore((s) => s.setScreen)

  const [confirmTitle, setConfirmTitle] = useState('')
  const [shake, setShake] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!project) return <></>

  async function tryEnter(): Promise<void> {
    if (!project) return
    if (project.authorsRoomUnlocked) {
      await openRoom(project.id)
      setScreen('authorsRoom')
      return
    }
    setBusy(true)
    try {
      const ok = await unlock(project.id, confirmTitle)
      if (!ok) {
        setShake(true)
        window.setTimeout(() => setShake(false), 500)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`card authors-gate ${shake ? 'shake' : ''}`}>
      <div className="authors-gate-head">
        <LockIcon size={20} />
        <h3>Author’s Room</h3>
      </div>
      <p className="muted">
        Everything the AI built to write this book — the world bible, outline, character notes,
        chapter plans and summaries, review findings. <strong>It is full of spoilers.</strong> Open
        it only once you’ve read (or don’t mind spoiling) the story.
      </p>

      {project.authorsRoomUnlocked ? (
        <button className="btn btn-primary" onClick={() => void tryEnter()}>
          Enter Author’s Room
        </button>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Type the exact book title to unlock</span>
            <input
              className="input"
              value={confirmTitle}
              placeholder={project.title}
              onChange={(e) => setConfirmTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void tryEnter()
              }}
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={() => void tryEnter()}
            disabled={busy || confirmTitle.length === 0}
          >
            {busy ? 'Unlocking…' : 'Unlock Author’s Room'}
          </button>
        </>
      )}
    </div>
  )
}

export function ExportScreen(): React.JSX.Element {
  const project = useSelectedProject()
  const costSummary = useStore((s) => s.costSummary)
  const liveCost = useStore((s) => (project ? s.liveCost[project.id] : undefined))
  const loadDashboard = useStore((s) => s.loadDashboard)
  const exportSaveAs = useStore((s) => s.exportSaveAs)
  const setIllustrations = useStore((s) => s.setIllustrations)
  const startProject = useStore((s) => s.startProject)
  const settings = useStore((s) => s.settings)
  const setScreenTop = useStore((s) => s.setScreen)
  const goHome = useStore((s) => s.goHome)

  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const cover = useStore((s) => (project ? s.covers[project.id] : undefined))
  const loadCover = useStore((s) => s.loadCover)

  const [annotation, setAnnotation] = useState<string | null>(null)

  const projectId = project?.id
  useEffect(() => {
    if (projectId) {
      void loadDashboard(projectId)
      void loadCover(projectId)
      window.api.invoke('project:annotation', projectId).then(setAnnotation).catch(() => setAnnotation(null))
    }
  }, [projectId, loadDashboard, loadCover])

  if (!project) {
    return (
      <div className="screen">
        <TopBar title="Export" onBack={() => void goHome()} />
        <div className="screen-body">
          <p className="muted">No project selected.</p>
        </div>
      </div>
    )
  }

  const cost = liveCost ?? costSummary?.costUsd ?? project.costUsd

  async function save(): Promise<void> {
    if (!project) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await exportSaveAs(project.id)
      if ('path' in res) setSavedPath(res.path)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen">
      <TopBar title={project.title} subtitle="Finished" onBack={() => void goHome()} />

      <div className="screen-body export-body">
       <div className="export-layout">
        <aside className="export-cover-col">
          {cover ? (
            <img className="export-cover" src={cover} alt="Book cover" />
          ) : (
            <div className="export-cover export-cover-empty">
              <BookIcon size={64} />
            </div>
          )}
          <p className="muted celebrate-eyebrow">Your book is written.</p>
          <h2 className="export-title">{project.bookTitle ?? project.title}</h2>
          <p className="muted">{project.chapterCount ?? project.chaptersDone} chapters, start to finish.</p>
          {annotation && <p className="export-blurb">{annotation}</p>}
        </aside>

        <div className="export-main-col">
        <div className="stat-row">
          <div className="card stat-tile">
            <span className="stat-value">{fmtInt(project.wordsWritten)}</span>
            <span className="stat-label">words</span>
          </div>
          <div className="card stat-tile">
            <span className="stat-value">{project.chaptersDone}</span>
            <span className="stat-label">chapters</span>
          </div>
          <div className="card stat-tile">
            <span className="stat-value">{fmtCost(cost)}</span>
            <span className="stat-label">total cost</span>
          </div>
        </div>

        <div className="card export-card">
          <div>
            <h3 className="panel-title">Save your book</h3>
            <p className="muted">Export as an FB2 e-book you can read anywhere.</p>
          </div>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save as FB2…'}
          </button>
        </div>
        {savedPath && (
          <div className="banner banner-ready">Saved to {savedPath}</div>
        )}
        {saveError && <div className="banner banner-error">{saveError}</div>}

        {!project.illustrations && !project.isTranslation && (
          <div className="card export-card">
            <div>
              <h3 className="panel-title">Add illustrations</h3>
              <p className="muted">
                Paint a style-locked cover and one image per chapter (gpt-image-2), then re-export.
              </p>
              {settings && !settings.openaiKeySet && (
                <p className="muted" style={{ color: 'var(--amber)' }}>
                  Requires an OpenAI API key — add it in Settings first.
                </p>
              )}
            </div>
            <button
              className="btn btn-ghost"
              disabled={!settings?.openaiKeySet}
              onClick={() => {
                void (async () => {
                  await setIllustrations(project.id, true)
                  await startProject(project.id)
                  setScreenTop('progress')
                })()
              }}
            >
              Illustrate the book
            </button>
          </div>
        )}

        <LanguagesCard project={project} />

        <AuthorsRoomGate />
        </div>
       </div>
      </div>
    </div>
  )
}
