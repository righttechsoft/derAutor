import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { SettingsPatch } from '../store'
import { TopBar } from '../components/TopBar'

export function Settings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const loadSettings = useStore((s) => s.loadSettings)
  const saveSettings = useStore((s) => s.saveSettings)
  const goHome = useStore((s) => s.goHome)

  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [plannerModel, setPlannerModel] = useState('')
  const [drafterModel, setDrafterModel] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [textProvider, setTextProvider] = useState<'api' | 'claude-code'>('api')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    if (settings) {
      setPlannerModel(settings.plannerModel)
      setDrafterModel(settings.drafterModel)
      setAuthorName(settings.authorName)
      setTextProvider(settings.textProvider)
    }
  }, [settings])

  async function save(): Promise<void> {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const patch: SettingsPatch = {}
    if (anthropicKey.trim()) patch.anthropicKey = anthropicKey.trim()
    if (openaiKey.trim()) patch.openaiKey = openaiKey.trim()
    if (plannerModel.trim() && plannerModel.trim() !== settings.plannerModel)
      patch.plannerModel = plannerModel.trim()
    if (drafterModel.trim() && drafterModel.trim() !== settings.drafterModel)
      patch.drafterModel = drafterModel.trim()
    if (authorName.trim() && authorName.trim() !== settings.authorName)
      patch.authorName = authorName.trim()
    if (textProvider !== settings.textProvider) patch.textProvider = textProvider

    try {
      await saveSettings(patch)
      setAnthropicKey('')
      setOpenaiKey('')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen">
      <TopBar title="Settings" onBack={() => void goHome()} />

      <div className="screen-body narrow">
        <div className="card form-card">
          <h3 className="panel-title">API keys</h3>
          <label className="field">
            <span className="field-label">Anthropic API key</span>
            <input
              className="input"
              type="password"
              value={anthropicKey}
              placeholder={settings?.anthropicKeySet ? 'configured' : 'sk-ant-…'}
              autoComplete="off"
              onChange={(e) => setAnthropicKey(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">OpenAI API key</span>
            <input
              className="input"
              type="password"
              value={openaiKey}
              placeholder={settings?.openaiKeySet ? 'configured' : 'sk-…'}
              autoComplete="off"
              onChange={(e) => setOpenaiKey(e.target.value)}
            />
          </label>
          <p className="field-hint">Keys are stored encrypted via Windows DPAPI.</p>
        </div>

        <div className="card form-card">
          <h3 className="panel-title">Author</h3>
          <label className="field">
            <span className="field-label">Author name (printed in exported books)</span>
            <input
              className="input"
              value={authorName}
              placeholder="Damien Knox"
              onChange={(e) => setAuthorName(e.target.value)}
            />
          </label>
        </div>

        <div className="card form-card">
          <h3 className="panel-title">Text generation</h3>
          <label className="field">
            <span className="field-label">Provider</span>
            <select
              className="input"
              value={textProvider}
              onChange={(e) => setTextProvider(e.target.value as 'api' | 'claude-code')}
            >
              <option value="api">Anthropic API (pay per token)</option>
              <option value="claude-code">Claude Code (local subscription)</option>
            </select>
          </label>
          {textProvider === 'claude-code' && (
            <p className="field-hint">
              Uses your local Claude Code login — no API charges, but plan usage limits apply
              (5-hour windows). If a limit is hit mid-book, the run stops with an error; press
              Start again after the window resets. Illustrations still use the OpenAI API key.
            </p>
          )}
        </div>

        <div className="card form-card">
          <h3 className="panel-title">Models</h3>
          <label className="field">
            <span className="field-label">Planner model</span>
            <input
              className="input"
              value={plannerModel}
              placeholder="claude-opus-4-8"
              onChange={(e) => setPlannerModel(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Drafter model</span>
            <input
              className="input"
              value={drafterModel}
              placeholder="claude-sonnet-5"
              onChange={(e) => setDrafterModel(e.target.value)}
            />
          </label>
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <div className="form-actions">
          {saved && <span className="saved-note">Saved</span>}
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !settings}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  )
}
