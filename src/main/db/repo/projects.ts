import type { NewProjectInput, ProjectSummary, ProjectStatus, Stage } from '@shared/domain'
import { countWords } from '@shared/domain'
import { getDb, newId, nowIso } from '../database'

export interface ProjectRow {
  id: string
  title: string
  language: string
  target_words: number
  illustrations: number
  genre_hint: string
  world_input: string
  premise_input: string
  style_input: string
  stage: Stage
  status: ProjectStatus
  chapter_count: number | null
  review_round: number
  authors_room_unlocked: number
  error: string | null
  source_project_id: string | null
  guided: number
  pending_step: string | null
  edit_copy: number
  edit_label: string | null
  created_at: string
  updated_at: string
}

export function createProject(input: NewProjectInput): ProjectRow {
  const id = newId()
  const now = nowIso()
  getDb()
    .prepare(
      `INSERT INTO projects (id, title, language, target_words, illustrations, genre_hint,
        world_input, premise_input, style_input, stage, status, source_project_id, guided, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'clarify', 'idle', ?, ?, ?, ?)`
    )
    .run(
      id,
      input.title,
      input.language,
      input.targetWords,
      input.illustrations ? 1 : 0,
      input.genreHint,
      input.worldInput,
      input.premiseInput,
      input.styleInput ?? '',
      input.sourceProjectId ?? null,
      input.guided ? 1 : 0,
      now,
      now
    )
  return getProjectRow(id)
}

export function getProjectRow(id: string): ProjectRow {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined
  if (!row) throw new Error(`Project not found: ${id}`)
  return row
}

export function listProjectRows(): ProjectRow[] {
  return getDb()
    .prepare('SELECT * FROM projects ORDER BY created_at DESC')
    .all() as unknown as ProjectRow[]
}

export function updateProject(
  id: string,
  fields: Partial<
    Pick<
      ProjectRow,
      | 'stage'
      | 'status'
      | 'chapter_count'
      | 'review_round'
      | 'error'
      | 'illustrations'
      | 'guided'
      | 'pending_step'
      | 'edit_copy'
      | 'edit_label'
    > & {
      authors_room_unlocked: number
    }
  >
): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[]
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  getDb()
    .prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k] ?? null), nowIso(), id)
}

/** After a crash, projects can be stuck status='running' with no live run — normalize at boot. */
export function reconcileInterruptedProjects(): void {
  getDb().prepare(`UPDATE projects SET status = 'paused' WHERE status = 'running'`).run()
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/** Named edit variants cloned from a finished book (edit_copy=1), oldest first. */
export function listEditVariants(sourceProjectId: string): ProjectRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM projects WHERE source_project_id = ? AND edit_copy = 1 ORDER BY created_at`
    )
    .all(sourceProjectId) as unknown as ProjectRow[]
}

export function toSummary(row: ProjectRow): ProjectSummary {
  const db = getDb()
  const chaptersDone = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND kind = 'chapter_final' AND is_current = 1`
      )
      .get(row.id) as { n: number }
  ).n
  const words = (
    db
      .prepare(
        `SELECT content FROM artifacts WHERE project_id = ? AND kind = 'chapter_final' AND is_current = 1`
      )
      .all(row.id) as { content: string }[]
  ).reduce((sum, a) => sum + countWords(a.content), 0)
  const cost = (
    db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_calls WHERE project_id = ?')
      .get(row.id) as { c: number }
  ).c
  const sourceTitle = row.source_project_id
    ? ((db.prepare('SELECT title FROM projects WHERE id = ?').get(row.source_project_id) as
        | { title: string }
        | undefined)?.title ?? null)
    : null
  const isTranslation =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND kind = 'translation_seed' AND is_current = 1`
        )
        .get(row.id) as { n: number }
    ).n > 0
  // Reveal the generated book title only once finished — before then it stays spoiler-free.
  let bookTitle: string | null = null
  if (row.stage === 'done') {
    const outline = db
      .prepare(`SELECT content FROM artifacts WHERE project_id = ? AND kind = 'outline' AND is_current = 1`)
      .get(row.id) as { content: string } | undefined
    if (outline) {
      try {
        const parsed = JSON.parse(outline.content) as { bookTitle?: unknown }
        if (typeof parsed.bookTitle === 'string' && parsed.bookTitle.trim()) bookTitle = parsed.bookTitle
      } catch {
        // unreadable outline — leave the working title
      }
    }
  }

  return {
    id: row.id,
    title: row.title,
    bookTitle,
    language: row.language,
    targetWords: row.target_words,
    illustrations: !!row.illustrations,
    genreHint: row.genre_hint,
    stage: row.stage,
    status: row.status,
    chapterCount: row.chapter_count,
    chaptersDone,
    reviewRound: row.review_round,
    authorsRoomUnlocked: !!row.authors_room_unlocked,
    wordsWritten: words,
    costUsd: cost,
    error: row.error,
    sourceProjectId: row.source_project_id,
    sourceTitle,
    isTranslation,
    isEditCopy: !!row.edit_copy,
    editLabel: row.edit_label ?? null,
    guided: !!row.guided,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
