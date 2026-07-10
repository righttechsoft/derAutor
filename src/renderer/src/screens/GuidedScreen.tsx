import React, { useEffect, useState } from 'react'
import { useStore, useSelectedProject } from '../store'
import { TopBar } from '../components/TopBar'
import { StageStepper } from '../components/StageStepper'
import { StatusBadge } from '../components/Badges'
import { fmtCost } from '../format'

function prettify(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function GuidedScreen(): React.JSX.Element {
  const project = useSelectedProject()
  const pending = useStore((s) => s.guidedPending)
  const stream = useStore((s) => s.guidedStream)
  const busy = useStore((s) => s.guidedBusy)
  const error = useStore((s) => s.guidedError)
  const liveCost = useStore((s) => (project ? s.liveCost[project.id] : undefined))

  const loadGuided = useStore((s) => s.loadGuided)
  const approveStep = useStore((s) => s.approveStep)
  const regenerateStep = useStore((s) => s.regenerateStep)
  const editStep = useStore((s) => s.editStep)
  const refineStep = useStore((s) => s.refineStep)
  const runFree = useStore((s) => s.runFree)
  const startProject = useStore((s) => s.startProject)
  const loadArtifacts = useStore((s) => s.loadArtifacts)
  const setScreen = useStore((s) => s.setScreen)
  const goHome = useStore((s) => s.goHome)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [chat, setChat] = useState('')

  const projectId = project?.id
  const status = project?.status
  useEffect(() => {
    if (projectId && status === 'awaiting') void loadGuided(projectId)
  }, [projectId, status, loadGuided])

  if (!project) {
    return (
      <div className="screen">
        <TopBar title="Guided" onBack={() => void goHome()} />
        <div className="screen-body">
          <p className="muted">No project selected.</p>
        </div>
      </div>
    )
  }

  const isAwaiting = project.status === 'awaiting'
  const isRunning = project.status === 'running' || busy
  const isIdle = project.status === 'idle' || project.status === 'paused'
  const cost = liveCost ?? project.costUsd

  async function openAuthorsRoom(): Promise<void> {
    if (!project) return
    await loadArtifacts(project.id)
    setScreen('authorsRoom')
  }

  function beginEdit(): void {
    if (!pending) return
    setDraft(pending.content)
    setEditing(true)
  }

  async function saveEdit(): Promise<void> {
    if (!project) return
    await editStep(project.id, draft)
    setEditing(false)
  }

  function sendChat(): void {
    const text = chat.trim()
    if (!text || !project || busy) return
    setChat('')
    void refineStep(project.id, text)
  }

  return (
    <div className="screen">
      <TopBar
        title={project.title}
        subtitle="Guided — you approve every step"
        onBack={() => void goHome()}
        right={<StatusBadge status={project.status} />}
      />

      <div className="screen-body">
        {error && <div className="banner banner-error">{error}</div>}

        <div className="card panel">
          <StageStepper
            current={project.stage}
            illustrations={project.illustrations}
            isTranslation={project.isTranslation}
          />
        </div>

        <div className="card panel">
          <div className="guided-head">
            <h3 className="panel-title">
              {pending ? pending.label : isRunning ? 'Writing…' : 'Ready when you are'}
            </h3>
            <span className="cost-chip">{fmtCost(cost)}</span>
          </div>

          {isRunning && !pending ? (
            <pre className="guided-stream">
              {stream || 'The model is thinking…'}
              <span className="caret">▍</span>
            </pre>
          ) : editing ? (
            <>
              <textarea
                className="input textarea guided-editor"
                rows={20}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="controls">
                <button className="btn btn-primary" onClick={() => void saveEdit()}>
                  Save edit
                </button>
                <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : pending ? (
            <pre className="viewer-pre">{prettify(pending.content)}</pre>
          ) : isIdle ? (
            <p className="muted">
              Press start — the pipeline will build the first step and stop here for your approval.
            </p>
          ) : (
            <pre className="guided-stream">{stream || 'Working…'}</pre>
          )}
        </div>

        {isAwaiting && pending && !editing && (
          <>
            <div className="controls">
              <button className="btn btn-primary" onClick={() => void approveStep(project.id)}>
                Approve &amp; continue
              </button>
              <button className="btn btn-ghost" onClick={() => void regenerateStep(project.id)}>
                Regenerate
              </button>
              <button className="btn btn-ghost" onClick={beginEdit}>
                Edit
              </button>
              <button className="btn btn-ghost" onClick={() => void runFree(project.id)}>
                Run without stopping
              </button>
            </div>

            <div className="card panel">
              <h3 className="panel-title">Refine — tell the model what to change</h3>
              {pending.messages.length > 0 && (
                <div className="guided-chat">
                  {pending.messages.map((m, i) => (
                    <div key={i} className={`guided-msg guided-msg-${m.role}`}>
                      {m.content}
                    </div>
                  ))}
                </div>
              )}
              {busy && <p className="muted">{stream ? stream : 'Revising…'}</p>}
              <div className="guided-composer">
                <textarea
                  className="input textarea"
                  rows={3}
                  placeholder="e.g. Make the opening darker; the protagonist wouldn't trust her so fast."
                  value={chat}
                  disabled={busy}
                  onChange={(e) => setChat(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat()
                  }}
                />
                <button className="btn btn-primary" onClick={sendChat} disabled={busy || chat.trim().length === 0}>
                  {busy ? 'Working…' : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}

        <div className="controls">
          {isIdle && (
            <button className="btn btn-primary" onClick={() => void startProject(project.id)}>
              {project.status === 'paused' ? 'Resume' : 'Start'}
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => void openAuthorsRoom()}>
            Browse everything (Author’s Room)
          </button>
        </div>
      </div>
    </div>
  )
}
