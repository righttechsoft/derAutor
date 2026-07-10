import type { CostSummary } from '@shared/domain'
import { getDb, newId, nowIso } from '../database'

export interface LlmCallRecord {
  projectId: string | null
  jobId: string | null
  provider: 'anthropic' | 'claude-code' | 'openai' | 'mock'
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  durationMs: number
  stopReason: string | null
}

/** NOT wrapped in its own transaction — the engine commits job+artifact+usage atomically. */
export function recordLlmCall(rec: LlmCallRecord): void {
  getDb()
    .prepare(
      `INSERT INTO llm_calls (id, project_id, job_id, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, stop_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(),
      rec.projectId,
      rec.jobId,
      rec.provider,
      rec.model,
      rec.inputTokens,
      rec.outputTokens,
      rec.cacheReadTokens,
      rec.cacheWriteTokens,
      rec.costUsd,
      rec.durationMs,
      rec.stopReason,
      nowIso()
    )
}

export function costSummary(projectId: string): CostSummary {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
              COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
              COALESCE(SUM(cost_usd),0) AS c, COUNT(*) AS n
       FROM llm_calls WHERE project_id = ?`
    )
    .get(projectId) as { i: number; o: number; cr: number; cw: number; c: number; n: number }
  return {
    inputTokens: row.i,
    outputTokens: row.o,
    cacheReadTokens: row.cr,
    cacheWriteTokens: row.cw,
    costUsd: row.c,
    calls: row.n
  }
}
