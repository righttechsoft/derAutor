import type { ReviewIssueStats } from '@shared/domain'
import type { ReviewIssue } from '@shared/schemas/reviewIssues'
import { getDb, inTransaction, newId, nowIso } from '../database'

export interface IssueRow {
  id: string
  project_id: string
  round: number
  chapter: number | null
  severity: string
  category: string
  description: string
  fix_instruction: string | null
  status: 'open' | 'fixed' | 'dismissed'
  created_at: string
}

const VALID_SEVERITIES = new Set(['minor', 'major', 'critical'])
const VALID_CATEGORIES = new Set(['continuity', 'logic', 'pacing', 'voice', 'boring'])

export function addIssues(projectId: string, round: number, issues: ReviewIssue[]): void {
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO review_issues (id, project_id, round, chapter, severity, category, description, fix_instruction, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  )
  inTransaction(() => {
    for (const i of issues) {
      const severity = VALID_SEVERITIES.has(i.severity.toLowerCase())
        ? i.severity.toLowerCase()
        : 'major'
      const category = VALID_CATEGORIES.has(i.category.toLowerCase())
        ? i.category.toLowerCase()
        : 'logic'
      insert.run(newId(), projectId, round, i.chapter, severity, category, i.description, i.fixInstruction, nowIso())
    }
  })
}

/**
 * ALL issues of a round regardless of status: the review stage plans its
 * rewrite/re-summary steps from this list so that a resume after a crash
 * mid-round (rewrite committed + issues marked fixed, re-summary not yet run)
 * still walks the same chapters — the done steps skip via their job records.
 */
export function issuesForRound(projectId: string, round: number): IssueRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM review_issues WHERE project_id = ? AND round = ? ORDER BY chapter, severity`
    )
    .all(projectId, round) as unknown as IssueRow[]
}

export function markIssuesFixed(projectId: string, round: number, chapter: number): void {
  getDb()
    .prepare(
      `UPDATE review_issues SET status = 'fixed' WHERE project_id = ? AND round = ? AND chapter = ?`
    )
    .run(projectId, round, chapter)
}

/** Spoiler-safe aggregate for the UI: counts only, no descriptions. */
export function issueStats(projectId: string): ReviewIssueStats[] {
  const rows = getDb()
    .prepare(
      `SELECT round, category, severity, status, COUNT(*) AS n
       FROM review_issues WHERE project_id = ?
       GROUP BY round, category, severity, status`
    )
    .all(projectId) as { round: number; category: string; severity: string; status: string; n: number }[]
  const byRound = new Map<number, ReviewIssueStats>()
  for (const r of rows) {
    let s = byRound.get(r.round)
    if (!s) {
      s = { round: r.round, total: 0, byCategory: {}, bySeverity: {}, open: 0 }
      byRound.set(r.round, s)
    }
    s.total += r.n
    s.byCategory[r.category] = (s.byCategory[r.category] ?? 0) + r.n
    s.bySeverity[r.severity] = (s.bySeverity[r.severity] ?? 0) + r.n
    if (r.status === 'open') s.open += r.n
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round)
}
