import type { ProjectStatus, Stage } from '@shared/domain'

export function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  if (n === 0) return '$0.00'
  if (n < 10) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function pct(done: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

export const STAGE_LABEL: Record<Stage, string> = {
  intake: 'Intake',
  clarify: 'Clarify',
  bible: 'World bible',
  chapters: 'Chapters',
  review: 'Review',
  illustrate: 'Illustrate',
  align: 'Align',
  export: 'Export',
  glossary: 'Glossary',
  translate: 'Translate',
  tcheck: 'Consistency check',
  done: 'Done'
}

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
  error: 'Error',
  cancelled: 'Cancelled',
  done: 'Done',
  awaiting: 'Awaiting you'
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
