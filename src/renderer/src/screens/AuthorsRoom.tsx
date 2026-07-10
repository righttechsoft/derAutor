import React, { useMemo, useState } from 'react'
import type { ArtifactKind, ArtifactMeta } from '@shared/domain'
import { useStore, useSelectedProject } from '../store'
import { TopBar } from '../components/TopBar'

const KIND_LABEL: Record<ArtifactKind, string> = {
  clarify_brief: 'Clarify brief',
  world_bible: 'World bible',
  characters: 'Characters',
  outline: 'Outline',
  style_guide: 'Style guide',
  chapter_plan: 'Chapter plans',
  chapter_final: 'Chapter text',
  chapter_summary: 'Chapter summaries',
  ledger: 'Continuity ledger',
  review_chunk: 'Review notes',
  image_style_block: 'Image style',
  image_style_override: 'Image style override',
  image_prompt: 'Image prompts',
  book_meta: 'Book metadata',
  world_seed: 'Inherited world',
  translation_seed: 'Original book',
  translation_glossary: 'Translation glossary'
}

// Rough authoring order so the sidebar reads like the pipeline.
const KIND_ORDER: ArtifactKind[] = [
  'world_seed',
  'translation_seed',
  'translation_glossary',
  'clarify_brief',
  'world_bible',
  'characters',
  'outline',
  'style_guide',
  'chapter_plan',
  'chapter_final',
  'chapter_summary',
  'ledger',
  'image_style_block',
  'image_prompt',
  'book_meta'
]

function artifactLabel(a: ArtifactMeta): string {
  const base = a.chapter != null ? `Chapter ${a.chapter}` : KIND_LABEL[a.kind]
  return a.version > 1 ? `${base} · v${a.version}` : base
}

function prettify(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function AuthorsRoom(): React.JSX.Element {
  const project = useSelectedProject()
  const artifacts = useStore((s) => s.artifacts)
  const readArtifact = useStore((s) => s.readArtifact)
  const setScreen = useStore((s) => s.setScreen)

  const [selected, setSelected] = useState<ArtifactMeta | null>(null)
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const groups = useMemo(() => {
    const byKind = new Map<ArtifactKind, ArtifactMeta[]>()
    for (const a of artifacts) {
      const arr = byKind.get(a.kind) ?? []
      arr.push(a)
      byKind.set(a.kind, arr)
    }
    for (const arr of byKind.values()) {
      arr.sort((x, y) => (x.chapter ?? 0) - (y.chapter ?? 0) || x.version - y.version)
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({
      kind: k,
      items: byKind.get(k) as ArtifactMeta[]
    }))
  }, [artifacts])

  async function open(a: ArtifactMeta): Promise<void> {
    if (!project) return
    setSelected(a)
    setLoading(true)
    setContent('')
    try {
      const raw = await readArtifact(project.id, a.id)
      setContent(prettify(raw))
    } catch (err) {
      setContent(err instanceof Error ? err.message : 'Could not read this artifact.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen">
      <TopBar
        title="Author’s Room"
        subtitle={project ? `${project.title} — contains spoilers` : 'contains spoilers'}
        onBack={() => setScreen('export')}
      />

      <div className="authors-room">
        <aside className="artifact-list">
          {groups.length === 0 && <p className="muted">No artifacts recorded.</p>}
          {groups.map((g) => (
            <div key={g.kind} className="artifact-group">
              <div className="artifact-group-head">{KIND_LABEL[g.kind]}</div>
              {g.items.map((a) => (
                <button
                  key={a.id}
                  className={`artifact-item ${selected?.id === a.id ? 'is-active' : ''}`}
                  onClick={() => void open(a)}
                >
                  {artifactLabel(a)}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="artifact-viewer">
          {!selected ? (
            <p className="muted viewer-placeholder">Select an artifact to read it.</p>
          ) : loading ? (
            <p className="muted viewer-placeholder">Loading…</p>
          ) : (
            <>
              <div className="viewer-head">{artifactLabel(selected)}</div>
              <pre className="viewer-pre">{content}</pre>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
