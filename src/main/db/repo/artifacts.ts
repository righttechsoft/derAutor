import type { ArtifactKind, ArtifactMeta } from '@shared/domain'
import { getDb, newId, nowIso } from '../database'

export interface ArtifactRow {
  id: string
  project_id: string
  kind: ArtifactKind
  chapter: number | null
  version: number
  is_current: number
  content: string
  created_at: string
}

/**
 * Stores a new current version of an artifact (previous versions kept, is_current=0).
 * NOT wrapped in its own transaction — callers (pipeline engine) provide one.
 */
export function saveArtifact(
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null,
  content: string
): string {
  const db = getDb()
  const prev = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM artifacts
       WHERE project_id = ? AND kind = ? AND chapter IS ?`
    )
    .get(projectId, kind, chapter) as { v: number }
  db.prepare(
    `UPDATE artifacts SET is_current = 0
     WHERE project_id = ? AND kind = ? AND chapter IS ? AND is_current = 1`
  ).run(projectId, kind, chapter)
  const id = newId()
  db.prepare(
    `INSERT INTO artifacts (id, project_id, kind, chapter, version, is_current, content, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, projectId, kind, chapter, prev.v + 1, content, nowIso())
  return id
}

export function getCurrentArtifact(
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null = null
): ArtifactRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM artifacts
         WHERE project_id = ? AND kind = ? AND chapter IS ? AND is_current = 1`
      )
      .get(projectId, kind, chapter) as ArtifactRow | undefined) ?? null
  )
}

export function getCurrentContent(
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null = null
): string | null {
  return getCurrentArtifact(projectId, kind, chapter)?.content ?? null
}

/** All current chapter-scoped artifacts of a kind, ordered by chapter. */
export function getChapterArtifacts(projectId: string, kind: ArtifactKind): ArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ? AND chapter IS NOT NULL AND is_current = 1
       ORDER BY chapter`
    )
    .all(projectId, kind) as unknown as ArtifactRow[]
}

export function listArtifactMeta(projectId: string): ArtifactMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, chapter, version, created_at FROM artifacts
       WHERE project_id = ? ORDER BY kind, chapter, version`
    )
    .all(projectId) as Pick<ArtifactRow, 'id' | 'kind' | 'chapter' | 'version' | 'created_at'>[]
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    chapter: r.chapter,
    version: r.version,
    createdAt: r.created_at
  }))
}

/**
 * Copies every current artifact from one project to another (fresh versions,
 * history not carried over). Used when an edit variant clones a finished book.
 * NOT wrapped in its own transaction — the caller provides one (mirrors
 * copyImages' contract).
 */
export function copyCurrentArtifacts(
  sourceId: string,
  destId: string,
  opts?: { exclude?: ArtifactKind[] }
): number {
  const exclude = new Set(opts?.exclude ?? [])
  const rows = getDb()
    .prepare(`SELECT kind, chapter, content FROM artifacts WHERE project_id = ? AND is_current = 1`)
    .all(sourceId) as unknown as Pick<ArtifactRow, 'kind' | 'chapter' | 'content'>[]
  let n = 0
  for (const r of rows) {
    if (exclude.has(r.kind)) continue
    saveArtifact(destId, r.kind, r.chapter, r.content)
    n++
  }
  return n
}

/** Every version of one artifact slot, oldest first (for undo). */
export function getArtifactVersions(
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null
): { version: number; content: string }[] {
  return getDb()
    .prepare(
      `SELECT version, content FROM artifacts
       WHERE project_id = ? AND kind = ? AND chapter IS ?
       ORDER BY version`
    )
    .all(projectId, kind, chapter) as unknown as { version: number; content: string }[]
}

export function getArtifactById(projectId: string, artifactId: string): ArtifactRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM artifacts WHERE project_id = ? AND id = ?')
      .get(projectId, artifactId) as ArtifactRow | undefined) ?? null
  )
}
