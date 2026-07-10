import { getDb, newId, nowIso } from '../database'

/** One turn of the per-step refine conversation in guided mode. */
export interface GuidedMessageRow {
  id: string
  project_id: string
  step_key: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export function addGuidedMessage(
  projectId: string,
  stepKey: string,
  role: 'user' | 'assistant',
  content: string
): GuidedMessageRow {
  const id = newId()
  getDb()
    .prepare(
      `INSERT INTO guided_messages (id, project_id, step_key, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectId, stepKey, role, content, nowIso())
  return getDb()
    .prepare('SELECT * FROM guided_messages WHERE id = ?')
    .get(id) as unknown as GuidedMessageRow
}

export function getGuidedMessages(projectId: string, stepKey: string): GuidedMessageRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM guided_messages WHERE project_id = ? AND step_key = ? ORDER BY created_at, id`
    )
    .all(projectId, stepKey) as unknown as GuidedMessageRow[]
}
