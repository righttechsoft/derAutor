import React, { useEffect, useRef, useState } from 'react'
import { useStore, useSelectedProject } from '../store'
import { TopBar } from '../components/TopBar'

type Scope = 'book' | 'chapter'

/** Floating selection-edit popup state: the verbatim span plus where to anchor it. */
interface SelectionPopup {
  chapter: number
  text: string
  x: number
  y: number
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function EditBook(): React.JSX.Element {
  const project = useSelectedProject()
  const chapters = useStore((s) => s.editChapters)
  const images = useStore((s) => s.editImages)
  const messages = useStore((s) => s.editMessages)
  const stream = useStore((s) => s.editStream)
  const busy = useStore((s) => s.editBusy)
  const report = useStore((s) => s.editReport)
  const error = useStore((s) => s.editError)
  const imageBusy = useStore((s) => s.imageBusy)
  const progress = useStore((s) => s.progress)
  const goHome = useStore((s) => s.goHome)
  const sendEditChat = useStore((s) => s.sendEditChat)
  const sendSelectionEdit = useStore((s) => s.sendSelectionEdit)
  const renameInBook = useStore((s) => s.renameInBook)
  const undoChapter = useStore((s) => s.undoChapter)
  const fixChapterImage = useStore((s) => s.fixChapterImage)
  const restyleAllImages = useStore((s) => s.restyleAllImages)
  const runProofread = useStore((s) => s.runProofread)

  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [scope, setScope] = useState<Scope>('book')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [restyleOpen, setRestyleOpen] = useState(false)
  const [restyleStyle, setRestyleStyle] = useState('')
  const [proofreadOpen, setProofreadOpen] = useState(false)
  const [fixInstruction, setFixInstruction] = useState('')
  const [selPopup, setSelPopup] = useState<SelectionPopup | null>(null)
  const [selInstruction, setSelInstruction] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLPreElement>(null)

  // Any background pipeline run (restyle-all, proofread) flips the project to 'running' —
  // that status is the single source of truth for the busy gate, same signal the
  // guided/progress screens use.
  const repainting = project?.status === 'running'
  const repaintMessage = project ? progress[project.id]?.message : undefined
  const backgroundMessage =
    project?.stage === 'illustrate'
      ? 'Repainting illustrations…'
      : project?.stage === 'align' || project?.stage === 'review'
        ? 'Proofreading your book…'
        : 'Working on your book…'

  useEffect(() => {
    // Keep the current selection across a reload if it still exists; only re-default otherwise.
    setSelectedChapter((prev) => {
      if (prev !== null && chapters.some((c) => c.chapter === prev)) return prev
      return chapters.length > 0 ? chapters[0].chapter : null
    })
  }, [chapters])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, stream])

  if (!project) {
    return (
      <div className="screen">
        <TopBar title="Edit" onBack={() => void goHome()} />
        <div className="screen-body">
          <p className="muted">No project selected.</p>
        </div>
      </div>
    )
  }

  const chapter = chapters.find((c) => c.chapter === selectedChapter) ?? null
  const image = images.find((i) => i.chapter === selectedChapter) ?? null

  function send(): void {
    const text = draft.trim()
    if (!text || busy || repainting) return
    setDraft('')
    void sendEditChat({
      message: text,
      chapter: scope === 'chapter' && selectedChapter !== null ? selectedChapter : undefined
    })
  }

  async function doRename(): Promise<void> {
    const from = renameFrom.trim()
    if (!from) return
    await renameInBook(from, renameTo)
    setRenameOpen(false)
    setRenameFrom('')
    setRenameTo('')
  }

  function doRestyle(): void {
    const style = restyleStyle.trim()
    if (!style || repainting) return
    setRestyleStyle('')
    setRestyleOpen(false)
    void restyleAllImages(style)
  }

  function doFixImage(): void {
    if (!chapter || repainting || imageBusy[chapter.chapter]) return
    const instruction = fixInstruction.trim()
    setFixInstruction('')
    void fixChapterImage(chapter.chapter, instruction || undefined)
  }

  function doProofread(mode: 'align' | 'full-review'): void {
    if (repainting) return
    setProofreadOpen(false)
    void runProofread(mode)
  }

  /** Selection popup: only fires for a non-empty selection fully inside the prose viewer. */
  function onViewerMouseUp(): void {
    const sel = window.getSelection()
    if (!chapter || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelPopup(null)
      return
    }
    const text = sel.toString().trim()
    const node = viewerRef.current
    if (!text || !node || !sel.anchorNode || !sel.focusNode) {
      setSelPopup(null)
      return
    }
    if (!node.contains(sel.anchorNode) || !node.contains(sel.focusNode)) {
      setSelPopup(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setSelPopup({ chapter: chapter.chapter, text, x: rect.left + rect.width / 2, y: rect.bottom })
    setSelInstruction('')
  }

  async function applySelectionEdit(): Promise<void> {
    if (!selPopup || busy || repainting) return
    const instruction = selInstruction.trim()
    if (!instruction) return
    const { chapter: ch, text } = selPopup
    setSelPopup(null)
    setSelInstruction('')
    window.getSelection()?.removeAllRanges()
    await sendSelectionEdit(ch, text, instruction)
  }

  return (
    <div className="screen">
      <TopBar
        title={project.bookTitle ?? project.title}
        subtitle={project.editLabel ? `Edit variant — ${project.editLabel}` : 'Edit variant'}
        onBack={() => void goHome()}
        right={
          <>
            <button
              className="btn btn-ghost btn-subtle"
              onClick={() => setRenameOpen((v) => !v)}
              disabled={repainting}
            >
              Rename…
            </button>
            <button
              className="btn btn-ghost btn-subtle"
              onClick={() => setRestyleOpen((v) => !v)}
              disabled={repainting}
            >
              Restyle images…
            </button>
            <button
              className="btn btn-ghost btn-subtle"
              onClick={() => setProofreadOpen((v) => !v)}
              disabled={repainting}
            >
              Proofread…
            </button>
          </>
        }
      />

      {repainting && (
        <div className="banner banner-ready edit-repaint-banner">
          {backgroundMessage} this can take a while{repaintMessage ? ` — ${repaintMessage}` : ''}
        </div>
      )}

      {renameOpen && (
        <div className="edit-book-rename">
          <span className="muted">Replace</span>
          <input
            className="input"
            value={renameFrom}
            placeholder="find text"
            onChange={(e) => setRenameFrom(e.target.value)}
          />
          <span className="muted">with</span>
          <input
            className="input"
            value={renameTo}
            placeholder="replacement"
            onChange={(e) => setRenameTo(e.target.value)}
          />
          <button className="btn btn-primary" onClick={() => void doRename()} disabled={!renameFrom.trim()}>
            Replace everywhere
          </button>
          <button className="btn btn-ghost" onClick={() => setRenameOpen(false)}>
            Cancel
          </button>
        </div>
      )}

      {restyleOpen && (
        <div className="edit-book-rename">
          <span className="muted">New style</span>
          <input
            className="input"
            value={restyleStyle}
            placeholder="e.g. moody watercolor, warmer palette, more painterly"
            disabled={repainting}
            onChange={(e) => setRestyleStyle(e.target.value)}
          />
          <button className="btn btn-primary" onClick={doRestyle} disabled={repainting || !restyleStyle.trim()}>
            Repaint all images
          </button>
          <button className="btn btn-ghost" onClick={() => setRestyleOpen(false)}>
            Cancel
          </button>
          {/* ponytail: reference-image upload is a later phase — placeholder only */}
          <button className="btn btn-ghost btn-subtle" disabled title="Coming soon">
            Upload reference image…
          </button>
        </div>
      )}

      {proofreadOpen && (
        <div className="edit-book-rename edit-book-proofread">
          <div className="edit-proofread-option">
            <button className="btn btn-primary btn-sm" onClick={() => doProofread('align')} disabled={repainting}>
              Align (recommended)
            </button>
            <span className="muted">
              Recompute continuity from your edits and fix only discrepancies. Keeps your hand-edited chapters.
            </span>
          </div>
          <div className="edit-proofread-option">
            <button className="btn btn-ghost btn-sm" onClick={() => doProofread('full-review')} disabled={repainting}>
              Full review
            </button>
            <span className="muted">
              Whole-book re-read; may rewrite chapters. Thorough but can change text you edited.
            </span>
          </div>
          <button className="btn btn-ghost" onClick={() => setProofreadOpen(false)}>
            Cancel
          </button>
        </div>
      )}

      <div className="edit-book-body">
        <aside className="edit-book-chat">
          <div className="chat-scroll" ref={scrollRef}>
            {messages.length === 0 && !busy && (
              <p className="muted chat-placeholder">
                Ask the editor to change something — a rename, a scene rewrite, a tone shift.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`bubble bubble-${m.role}`}>
                <span className="bubble-role">{m.role === 'user' ? 'You' : 'Editor'}</span>
                <div className="bubble-body">{m.content}</div>
              </div>
            ))}
            {busy && (
              <div className="bubble bubble-assistant">
                <span className="bubble-role">Editor</span>
                <div className="bubble-body">
                  {stream}
                  <span className="caret" />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="banner banner-error edit-book-error">
              <span>The editor hit a problem: {error}</span>
              {/* ponytail: no dedicated dismiss action — clearing this single field directly is simplest */}
              <button
                className="as-button"
                aria-label="Dismiss"
                onClick={() => useStore.setState({ editError: null })}
              >
                ×
              </button>
            </div>
          )}

          {report && (
            <p className="muted edit-report-line">
              Applied {report.applied} · {report.notFound} not found · {report.ambiguous} ambiguous
            </p>
          )}

          <div className="clarify-footer">
            <div className="edit-scope-row">
              <span className="muted">Scope</span>
              <select className="input" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                <option value="book">Whole book</option>
                <option value="chapter" disabled={selectedChapter === null}>
                  This chapter{selectedChapter !== null ? ` (${selectedChapter})` : ''}
                </option>
              </select>
            </div>
            <div className="chat-input-row">
              <textarea
                className="input textarea chat-input"
                rows={2}
                value={draft}
                placeholder="Ask the editor to change something…"
                disabled={busy || repainting}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button className="btn btn-primary" onClick={send} disabled={busy || repainting || !draft.trim()}>
                {busy ? 'Thinking…' : 'Send'}
              </button>
            </div>
          </div>
        </aside>

        <div className="authors-room">
          <aside className="artifact-list">
            {chapters.length === 0 && <p className="muted">No chapters found.</p>}
            {chapters.map((c) => (
              <button
                key={c.chapter}
                className={`artifact-item ${selectedChapter === c.chapter ? 'is-active' : ''}`}
                onClick={() => setSelectedChapter(c.chapter)}
              >
                Chapter {c.chapter}
                {c.title ? ` — ${c.title}` : ''}
              </button>
            ))}
          </aside>

          <section className="artifact-viewer">
            {!chapter ? (
              <p className="muted viewer-placeholder">Select a chapter to read it.</p>
            ) : (
              <>
                <div className="viewer-head-row">
                  <div className="viewer-head">
                    Chapter {chapter.chapter}
                    {chapter.title ? ` — ${chapter.title}` : ''}
                  </div>
                  <button
                    className="btn btn-ghost btn-subtle"
                    onClick={() => void undoChapter(chapter.chapter)}
                    disabled={repainting}
                  >
                    Undo
                  </button>
                </div>
                {image && (
                  <div className="edit-image-block">
                    <img className="edit-book-image" src={image.dataUrl} alt="" />
                    <div className="edit-image-controls">
                      <input
                        className="input"
                        value={fixInstruction}
                        placeholder="Fix this image… (optional instruction)"
                        disabled={repainting || imageBusy[chapter.chapter]}
                        onChange={(e) => setFixInstruction(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            doFixImage()
                          }
                        }}
                      />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={doFixImage}
                        disabled={repainting || imageBusy[chapter.chapter]}
                      >
                        {imageBusy[chapter.chapter] ? 'Rendering…' : 'Fix this image…'}
                      </button>
                    </div>
                    {/* ponytail: image edits overwrite the file directly — surface that it's not undoable */}
                    <p className="muted edit-image-warning">Image edits are permanent — there's no undo.</p>
                  </div>
                )}
                <pre className="viewer-pre" ref={viewerRef} onMouseUp={onViewerMouseUp}>{chapter.content}</pre>
              </>
            )}
          </section>
        </div>
      </div>

      {selPopup && (
        <div className="selection-popup" style={{ left: selPopup.x, top: selPopup.y }}>
          <div className="selection-popup-quote">“{truncate(selPopup.text, 140)}”</div>
          <input
            className="input"
            autoFocus
            value={selInstruction}
            placeholder="Change this to…"
            disabled={busy || repainting}
            onChange={(e) => setSelInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void applySelectionEdit()
              } else if (e.key === 'Escape') {
                setSelPopup(null)
              }
            }}
          />
          <div className="selection-popup-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void applySelectionEdit()}
              disabled={busy || repainting || !selInstruction.trim()}
            >
              Apply
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelPopup(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
