import { createHash } from 'crypto'
import type { ArtifactKind, Stage } from '@shared/domain'
import { countWords } from '@shared/domain'
import type { LlmUsage } from '../llm/types'
import { inTransaction } from '../db/database'
import { getChapterArtifacts, saveArtifact } from '../db/repo/artifacts'
import { beginJob, isStepDone, markJobDone, markJobFailed } from '../db/repo/jobs'
import { costSummary, recordLlmCall } from '../db/repo/usage'
import { getProjectRow, updateProject } from '../db/repo/projects'
import { log, logError } from '../services/logger'
import { sendEvent } from '../ipc/events'

/**
 * Control-flow signal for user pause/cancel — never surfaces as a project error.
 * 'awaiting' is the guided-mode gate: a step finished and the run suspends until
 * the author approves/regenerates/edits/refines it.
 */
export class PipelineInterrupted extends Error {
  constructor(public readonly kind: 'paused' | 'cancelled' | 'awaiting') {
    super(`Pipeline ${kind}`)
    this.name = 'PipelineInterrupted'
  }
}

export interface StepContext {
  projectId: string
  signal: AbortSignal
  /** Throws PipelineInterrupted if the user paused or cancelled. Called between steps and after aborts. */
  checkpoint(): void
}

export interface StepResult {
  /** Stored as the new current version and linked to the job. */
  artifact?: { kind: ArtifactKind; chapter: number | null; content: string }
  /** Extra DB writes committed atomically with job completion (issues, images, project fields). */
  sideEffect?: () => void
}

/** Deterministic hash over a step's inputs; a mismatch on resume re-runs the step. */
export function stepHash(...inputs: (string | number | null | undefined)[]): string {
  const h = createHash('sha256')
  for (const part of inputs) {
    const s = String(part ?? '')
    h.update(`${s.length}:`).update(s) // length prefix - no boundary ambiguity between parts
  }
  return h.digest('hex')
}

/**
 * Records one physical API call's spend the moment it completes — independent
 * of the step transaction, so failed/retried steps still account their cost.
 */
export function makeUsageRecorder(projectId: string, stepKey: string): (u: LlmUsage) => void {
  return (u) => {
    recordLlmCall({
      projectId,
      jobId: stepKey,
      provider: u.provider,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      costUsd: u.costUsd,
      durationMs: u.durationMs,
      stopReason: u.stopReason
    })
    emitCost(projectId)
    emitActivity(
      projectId,
      u.provider === 'openai'
        ? `· ${u.model}: image generated in ${fmtSecs(u.durationMs)} ($${u.costUsd.toFixed(2)})`
        : `· ${u.model}: ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out tokens, ${fmtSecs(u.durationMs)}, $${u.costUsd.toFixed(2)}${u.stopReason === 'max_tokens' ? ' — truncated, enlarging budget' : ''}`
    )
  }
}

function isNonRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    err instanceof PipelineInterrupted ||
    msg.includes('not configured') ||
    msg.includes('refused') ||
    msg.includes('invalid_request') ||
    /usage limit|limit reached/i.test(msg)
  )
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}

const RETRY_DELAYS_MS =
  process.env.DERAUTOR_FAST_RETRY === '1' ? [10, 10] : [15_000, 60_000]

/**
 * The checkpoint primitive: exactly one unit of work (usually one LLM/image call).
 * Skips instantly when the job is already done with the same input hash.
 * Artifact + job completion + usage rows commit in ONE transaction — a crash at
 * any point leaves either "not done" (re-run) or "fully done", never halfway.
 * Returns true when executed, false when skipped.
 */
export async function runStep(
  ctx: StepContext,
  stepKey: string,
  inputHash: string,
  fn: (recordUsage: (u: LlmUsage) => void, onToken?: (delta: string) => void) => Promise<StepResult>
): Promise<boolean> {
  ctx.checkpoint()
  if (isStepDone(ctx.projectId, stepKey, inputHash)) {
    log('engine', `skip ${stepKey} (already done)`)
    return false
  }
  const usageRecorder = makeUsageRecorder(ctx.projectId, stepKey)
  // Guided (co-writing) mode: stream this step's prose to the author and, once it
  // commits, suspend the run so they can approve/regenerate/edit/refine. Read fresh
  // each step so "run without stopping" (guided=0) takes effect immediately.
  const guided = getProjectRow(ctx.projectId).guided === 1
  const onToken = guided ? (delta: string): void => emitGuidedToken(ctx.projectId, delta) : undefined

  let result: StepResult | null = null
  for (let attempt = 0; ; attempt++) {
    ctx.checkpoint()
    beginJob(ctx.projectId, stepKey, inputHash)
    try {
      log('engine', `run ${stepKey} attempt=${attempt}`)
      emitActivity(ctx.projectId, attempt === 0 ? `▶ ${stepKey}` : `↻ ${stepKey} — retry ${attempt}`)
      const started = Date.now()
      result = await fn(usageRecorder, onToken)
      log('engine', `done ${stepKey} ms=${Date.now() - started}`)
      emitActivity(ctx.projectId, `✓ ${stepKey} done in ${fmtSecs(Date.now() - started)}`)
      const committed = result
      inTransaction(() => {
        let artifactId: string | null = null
        if (committed.artifact) {
          artifactId = saveArtifact(
            ctx.projectId,
            committed.artifact.kind,
            committed.artifact.chapter,
            committed.artifact.content
          )
        }
        committed.sideEffect?.()
        markJobDone(ctx.projectId, stepKey, artifactId)
        // Record what's awaiting the author's decision, atomic with the artifact.
        if (guided && committed.artifact) updateProject(ctx.projectId, { pending_step: stepKey })
      })
      break
    } catch (err) {
      logError('engine', `step ${stepKey} attempt=${attempt}`, err)
      // A user pause/cancel aborts the in-flight call; surface it as an interrupt,
      // not a failure — the job stays re-runnable.
      if (ctx.signal.aborted) {
        markJobFailed(ctx.projectId, stepKey, 'interrupted by user')
        ctx.checkpoint() // throws PipelineInterrupted with the right kind
        throw new PipelineInterrupted('cancelled')
      }
      const message = err instanceof Error ? err.message : String(err)
      if (isNonRetryable(err) || attempt >= RETRY_DELAYS_MS.length) {
        markJobFailed(ctx.projectId, stepKey, message)
        emitActivity(ctx.projectId, `✗ ${stepKey} failed: ${message.slice(0, 160)}`)
        throw err
      }
      emitActivity(
        ctx.projectId,
        `⚠ ${stepKey} attempt ${attempt + 1} failed (${message.slice(0, 120)}) — retrying in ${Math.round(RETRY_DELAYS_MS[attempt] / 1000)}s`
      )
      await sleep(RETRY_DELAYS_MS[attempt], ctx.signal)
    }
  }

  // The guided gate MUST live outside the try/catch above: throwing inside it would
  // land in the catch and markJobFailed the step we just committed. Only artifact-
  // bearing steps gate (sideEffect-only reads/collects run straight through).
  if (guided && result.artifact) {
    throw new PipelineInterrupted('awaiting')
  }
  return true
}

export function emitGuidedToken(projectId: string, delta: string): void {
  sendEvent('guided:token', { projectId, delta })
}

export function emitActivity(projectId: string, line: string): void {
  sendEvent('pipeline:activity', { projectId, at: new Date().toISOString(), line })
}

function fmtSecs(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`
}

export function emitCost(projectId: string): void {
  const c = costSummary(projectId)
  sendEvent('pipeline:cost', {
    projectId,
    costUsd: c.costUsd,
    outputTokens: c.outputTokens
  })
}

export function wordsWritten(projectId: string): number {
  return getChapterArtifacts(projectId, 'chapter_final').reduce(
    (sum, a) => sum + countWords(a.content),
    0
  )
}

export function emitProgress(
  projectId: string,
  stepKey: string,
  message: string,
  chapter: number | null = null,
  ofChapters: number | null = null
): void {
  const project = getProjectRow(projectId)
  sendEvent('pipeline:progress', {
    projectId,
    stage: project.stage as Stage,
    stepKey,
    chapter,
    ofChapters,
    wordsWritten: wordsWritten(projectId),
    message
  })
}
