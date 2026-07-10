import React, { useEffect, useRef, useState } from 'react'
import { useStore, useSelectedProject } from '../store'
import { TopBar } from '../components/TopBar'
import { SparkIcon } from '../components/Icons'

export function ClarifyChat(): React.JSX.Element {
  const project = useSelectedProject()
  const messages = useStore((s) => s.clarifyMessages)
  const pending = useStore((s) => s.pendingAssistant)
  const ready = useStore((s) => s.clarifyReady)
  const busy = useStore((s) => s.clarifyBusy)
  const clarifyError = useStore((s) => s.clarifyError)
  const sendClarify = useStore((s) => s.sendClarify)
  const startWriting = useStore((s) => s.startWriting)
  const goHome = useStore((s) => s.goHome)

  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pending])

  function send(): void {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void sendClarify(text)
  }

  function begin(viaProceed: boolean): void {
    setStarting(true)
    void startWriting(viaProceed)
  }

  return (
    <div className="screen clarify">
      <TopBar
        title={project?.title || 'Clarify'}
        subtitle="World interview"
        onBack={() => void goHome()}
      />

      <div className="clarify-hint">
        <SparkIcon size={16} />
        <span>
          The AI is interviewing you about your world to keep the story consistent. Answer its
          questions — nothing here spoils the plot.
        </span>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !pending && (
          <p className="muted chat-placeholder">
            The interview will begin shortly. Tell it anything it should know.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble bubble-${m.role}`}>
            <span className="bubble-role">{m.role === 'user' ? 'You' : 'Interviewer'}</span>
            <div className="bubble-body">{m.content}</div>
          </div>
        ))}
        {pending !== null && (
          <div className="bubble bubble-assistant">
            <span className="bubble-role">Interviewer</span>
            <div className="bubble-body">
              {pending}
              <span className="caret" />
            </div>
          </div>
        )}
      </div>

      {clarifyError && (
        <div className="banner banner-error">
          The interviewer hit a problem: {clarifyError} — send your message again to retry.
        </div>
      )}

      {ready && (
        <div className="banner banner-ready">
          World is consistent — ready to write.
        </div>
      )}

      <div className="clarify-footer">
        <div className="chat-input-row">
          <textarea
            className="input textarea chat-input"
            rows={2}
            value={draft}
            placeholder="Type your answer…"
            disabled={starting}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="btn btn-primary" onClick={send} disabled={busy || !draft.trim() || starting}>
            {busy ? 'Thinking…' : 'Send'}
          </button>
        </div>

        <div className="clarify-cta">
          {ready ? (
            <button className="btn btn-success" onClick={() => begin(false)} disabled={starting}>
              {starting ? 'Starting…' : 'Begin the book'}
            </button>
          ) : (
            <span className="muted clarify-cta-note">
              Keep answering until the world holds together, or move on whenever you like.
            </span>
          )}
          <button className="btn btn-ghost btn-subtle" onClick={() => begin(true)} disabled={starting}>
            Proceed anyway
          </button>
        </div>
      </div>
    </div>
  )
}
