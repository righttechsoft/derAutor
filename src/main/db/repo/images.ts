import { getDb, newId, nowIso } from '../database'

export interface ImageRow {
  id: string
  project_id: string
  kind: 'cover' | 'chapter'
  chapter: number | null
  prompt: string
  jpeg: Uint8Array | null
  width: number | null
  height: number | null
  status: 'pending' | 'done' | 'failed'
  created_at: string
}

export function saveImage(
  projectId: string,
  kind: 'cover' | 'chapter',
  chapter: number | null,
  prompt: string,
  jpeg: Buffer,
  width: number,
  height: number
): string {
  const db = getDb()
  db.prepare('DELETE FROM images WHERE project_id = ? AND kind = ? AND chapter IS ?').run(
    projectId,
    kind,
    chapter
  )
  const id = newId()
  db.prepare(
    `INSERT INTO images (id, project_id, kind, chapter, prompt, jpeg, width, height, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`
  ).run(id, projectId, kind, chapter, prompt, jpeg, width, height, nowIso())
  return id
}

export function getImage(
  projectId: string,
  kind: 'cover' | 'chapter',
  chapter: number | null = null
): ImageRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM images WHERE project_id = ? AND kind = ? AND chapter IS ? AND status = 'done'`
      )
      .get(projectId, kind, chapter) as ImageRow | undefined) ?? null
  )
}

export function listImages(projectId: string): ImageRow[] {
  return getDb()
    .prepare(`SELECT * FROM images WHERE project_id = ? AND status = 'done' ORDER BY kind, chapter`)
    .all(projectId) as unknown as ImageRow[]
}

/**
 * Copies every stored image from one project to another (fresh ids). Used when a
 * translation reuses the source book's language-independent illustrations. Not
 * self-transacted — the caller (createProjectTranslation) provides one.
 */
export function copyImages(sourceProjectId: string, destProjectId: string): number {
  const db = getDb()
  const rows = db
    .prepare(`SELECT kind, chapter, prompt, jpeg, width, height, status FROM images WHERE project_id = ?`)
    .all(sourceProjectId) as unknown as Omit<ImageRow, 'id' | 'project_id' | 'created_at'>[]
  const insert = db.prepare(
    `INSERT INTO images (id, project_id, kind, chapter, prompt, jpeg, width, height, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const now = nowIso()
  for (const r of rows) {
    insert.run(newId(), destProjectId, r.kind, r.chapter, r.prompt, r.jpeg, r.width, r.height, r.status, now)
  }
  return rows.length
}
