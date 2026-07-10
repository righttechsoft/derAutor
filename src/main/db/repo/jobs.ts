import type { JobStatus } from '@shared/domain'
import { getDb, newId, nowIso } from '../database'

export interface JobRow {
  id: string
  project_id: string
  step_key: string
  status: JobStatus
  attempt: number
  input_hash: string
  result_artifact_id: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export function getJob(projectId: string, stepKey: string): JobRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM jobs WHERE project_id = ? AND step_key = ?')
      .get(projectId, stepKey) as JobRow | undefined) ?? null
  )
}

/** Marks a step as running (creates the row on first attempt). */
export function beginJob(projectId: string, stepKey: string, inputHash: string): JobRow {
  const db = getDb()
  const existing = getJob(projectId, stepKey)
  const now = nowIso()
  if (existing) {
    db.prepare(
      `UPDATE jobs SET status = 'running', attempt = attempt + 1, input_hash = ?,
        error = NULL, started_at = ?, finished_at = NULL
       WHERE project_id = ? AND step_key = ?`
    ).run(inputHash, now, projectId, stepKey)
  } else {
    db.prepare(
      `INSERT INTO jobs (id, project_id, step_key, status, attempt, input_hash, created_at, started_at)
       VALUES (?, ?, ?, 'running', 1, ?, ?, ?)`
    ).run(newId(), projectId, stepKey, inputHash, now, now)
  }
  return getJob(projectId, stepKey)!
}

/** NOT wrapped in its own transaction — the engine commits job+artifact+usage atomically. */
export function markJobDone(
  projectId: string,
  stepKey: string,
  resultArtifactId: string | null
): void {
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'done', result_artifact_id = ?, error = NULL, finished_at = ?
       WHERE project_id = ? AND step_key = ?`
    )
    .run(resultArtifactId, nowIso(), projectId, stepKey)
}

export function markJobFailed(projectId: string, stepKey: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?
       WHERE project_id = ? AND step_key = ?`
    )
    .run(error, nowIso(), projectId, stepKey)
}

/** A step is complete when its job is done AND was produced from the same inputs. */
export function isStepDone(projectId: string, stepKey: string, inputHash: string): boolean {
  const job = getJob(projectId, stepKey)
  return job?.status === 'done' && job.input_hash === inputHash
}
