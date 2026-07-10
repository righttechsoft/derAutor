import React, { useMemo, useState } from 'react'
import { deriveChapterCount, type NewProjectInput } from '@shared/domain'
import { useStore } from '../store'
import { TopBar } from '../components/TopBar'

const PRESET_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Russian' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' }
]

export function NewProjectWizard(): React.JSX.Element {
  const createProject = useStore((s) => s.createProject)
  const goHome = useStore((s) => s.goHome)
  const projects = useStore((s) => s.projects)
  const doneProjects = projects.filter((p) => p.stage === 'done')

  const [sourceId, setSourceId] = useState('')
  const [title, setTitle] = useState('')
  const [langChoice, setLangChoice] = useState('en')
  const [customLang, setCustomLang] = useState('')
  const [targetWords, setTargetWords] = useState(90000)
  const [genreHint, setGenreHint] = useState('')
  const [illustrations, setIllustrations] = useState(false)
  const [guided, setGuided] = useState(false)
  const [worldInput, setWorldInput] = useState('')
  const [premiseInput, setPremiseInput] = useState('')
  const [styleInput, setStyleInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const language = langChoice === 'custom' ? customLang.trim() : langChoice
  const chapters = useMemo(() => deriveChapterCount(targetWords || 0), [targetWords])

  const canSubmit =
    title.trim().length > 0 &&
    language.length > 0 &&
    targetWords > 0 &&
    (worldInput.trim().length > 0 || sourceId !== '') &&
    !busy

  function pickSource(id: string): void {
    setSourceId(id)
    const source = doneProjects.find((p) => p.id === id)
    if (!source) return
    // Prefill from the source book (still editable).
    setGenreHint(source.genreHint)
    if (PRESET_LANGUAGES.some((l) => l.code === source.language)) {
      setLangChoice(source.language)
    } else {
      setLangChoice('custom')
      setCustomLang(source.language)
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const input: NewProjectInput = {
      title: title.trim(),
      language,
      targetWords,
      illustrations,
      genreHint: genreHint.trim(),
      worldInput: worldInput.trim(),
      premiseInput: premiseInput.trim(),
      styleInput: styleInput.trim(),
      sourceProjectId: sourceId || null,
      guided
    }
    try {
      await createProject(input)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not create the book.')
    }
  }

  return (
    <div className="screen">
      <TopBar title="New Book" subtitle="Describe the world; the AI takes it from there." onBack={() => void goHome()} />

      <div className="screen-body narrow">
        <div className="card form-card">
          {doneProjects.length > 0 && (
            <label className="field">
              <span className="field-label">Continue an existing world</span>
              <select className="input" value={sourceId} onChange={(e) => pickSource(e.target.value)}>
                <option value="">No — start a fresh world</option>
                {doneProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || 'Untitled'}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                The new book inherits the world of a finished book, including everything that
                changed in it. To translate a finished book, open it and use “Translate”.
              </span>
            </label>
          )}

          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="input"
              value={title}
              placeholder="Working title for your book"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span className="field-label">Language</span>
              <select className="input" value={langChoice} onChange={(e) => setLangChoice(e.target.value)}>
                {PRESET_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label} ({l.code})
                  </option>
                ))}
                <option value="custom">Other…</option>
              </select>
            </label>
            {langChoice === 'custom' && (
              <label className="field">
                <span className="field-label">Language code</span>
                <input
                  className="input"
                  value={customLang}
                  placeholder="e.g. it, ja, pt-BR"
                  onChange={(e) => setCustomLang(e.target.value)}
                />
              </label>
            )}
          </div>

          <div className="field-row">
            <label className="field">
              <span className="field-label">Target length</span>
              <input
                className="input"
                type="number"
                min={1000}
                step={1000}
                list="book-sizes"
                value={targetWords}
                onChange={(e) => setTargetWords(Number(e.target.value))}
              />
              <datalist id="book-sizes">
                <option value="30000" label="Novella" />
                <option value="60000" label="Short novel" />
                <option value="90000" label="Standard novel" />
                <option value="120000" label="Long novel" />
                <option value="150000" label="Epic" />
              </datalist>
              <span className="field-hint">≈ {chapters} chapters</span>
            </label>
            <label className="field">
              <span className="field-label">Genre hint</span>
              <input
                className="input"
                value={genreHint}
                placeholder="e.g. cozy mystery, hard sci-fi"
                onChange={(e) => setGenreHint(e.target.value)}
              />
            </label>
          </div>

          <label className="field field-toggle">
            <span>
              <span className="field-label">Illustrations</span>
              <span className="field-hint">Generate images for the finished book.</span>
            </span>
            <button
              type="button"
              className={`toggle ${illustrations ? 'toggle-on' : ''}`}
              role="switch"
              aria-checked={illustrations}
              onClick={() => setIllustrations((v) => !v)}
            >
              <span className="toggle-knob" />
            </button>
          </label>

          <label className="field field-toggle">
            <span>
              <span className="field-label">Guided mode</span>
              <span className="field-hint">
                Co-write: see every step live and approve, regenerate, edit or chat to refine it
                before the book continues.
              </span>
            </span>
            <button
              type="button"
              className={`toggle ${guided ? 'toggle-on' : ''}`}
              role="switch"
              aria-checked={guided}
              onClick={() => setGuided((v) => !v)}
            >
              <span className="toggle-knob" />
            </button>
          </label>

          <label className="field">
            <span className="field-label">
              {sourceId ? 'What is new or changed since the previous book (optional)' : 'Describe your world'}
            </span>
            <textarea
              className="input textarea"
              rows={6}
              value={worldInput}
              placeholder={
                sourceId
                  ? 'Time skips, new regions, shifted powers… anything the inherited world should account for.'
                  : 'The setting, its rules, tone, and anything that makes it feel real.'
              }
              onChange={(e) => setWorldInput(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Where does the story start?</span>
            <textarea
              className="input textarea"
              rows={4}
              value={premiseInput}
              placeholder="The opening situation or premise. Optional — leave the door open if you like."
              onChange={(e) => setPremiseInput(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Style (optional)</span>
            <textarea
              className="input textarea"
              rows={3}
              value={styleInput}
              placeholder="How it should be written — e.g. “funny fantasy, concise, only words starting with A” or “lyrical, present tense, short sentences.”"
              onChange={(e) => setStyleInput(e.target.value)}
            />
            <span className="field-hint">Shapes the narrative voice and prose rules for the whole book.</span>
          </label>

          {error && <div className="banner banner-error">{error}</div>}

          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => void goHome()} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create & clarify'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
