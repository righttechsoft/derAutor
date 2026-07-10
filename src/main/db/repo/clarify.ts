import type { ClarifyMessage } from '@shared/domain'
import { getDb, newId, nowIso } from '../database'

export function addClarifyMessage(
  projectId: string,
  role: 'user' | 'assistant',
  content: string,
  round: number
): ClarifyMessage {
  const id = newId()
  const createdAt = nowIso()
  getDb()
    .prepare(
      `INSERT INTO clarify_messages (id, project_id, role, content, round, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, role, content, round, createdAt)
  return { id, role, content, round, createdAt }
}

export function getClarifyHistory(projectId: string): ClarifyMessage[] {
  const rows = getDb()
    .prepare(
      'SELECT id, role, content, round, created_at FROM clarify_messages WHERE project_id = ? ORDER BY created_at, rowid'
    )
    .all(projectId) as {
    id: string
    role: 'user' | 'assistant'
    content: string
    round: number
    created_at: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    round: r.round,
    createdAt: r.created_at
  }))
}

export function currentClarifyRound(projectId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(round), 0) AS r FROM clarify_messages WHERE project_id = ?')
    .get(projectId) as { r: number }
  return row.r
}
