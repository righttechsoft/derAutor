import type { Stage } from '@shared/domain'
import { getProjectRow, updateProject } from '../db/repo/projects'
import { notifyPipelineRunning, sendEvent } from '../ipc/events'
import { log, logError } from '../services/logger'
import { PipelineInterrupted, type StepContext } from './engine'
import { runBibleStage } from './stages/bible'
import { runChapterLoop } from './stages/chapterLoop'
import { runReviewStage } from './stages/review'
import { runAlignStage } from './stages/align'
import { runIllustrateStage } from './stages/illustrate'
import { runExportStage } from './stages/exportStage'
import { runGlossaryStage, runTranslateStage, runTranslationCheckStage } from './stages/translate'
import { clarifyUserMessage, kickoffClarify } from './stages/clarify'

/**
 * Public control surface of the pipeline. Owns per-project run state.
 * The pipeline itself is fully checkpointed (see engine.ts): start after a
 * pause, crash, or app restart resumes from the first unfinished step.
 */

interface RunState {
  abort: AbortController
  intent: 'running' | 'pausing' | 'cancelling'
}

const runs = new Map<string, RunState>()

function emitStatus(projectId: string): void {
  const p = getProjectRow(projectId)
  sendEvent('pipeline:status', { projectId, status: p.status, stage: p.stage })
}

async function runPipeline(ctx: StepContext): Promise<void> {
  // The interactive clarify stage ends the moment the user starts the pipeline.
  if (getProjectRow(ctx.projectId).stage === 'clarify') {
    updateProject(ctx.projectId, { stage: 'bible' })
    emitStatus(ctx.projectId)
  }

  for (;;) {
    ctx.checkpoint()
    const project = getProjectRow(ctx.projectId)
    let next: Stage
    switch (project.stage) {
      case 'bible':
        await runBibleStage(ctx)
        next = 'chapters'
        break
      case 'chapters':
        await runChapterLoop(ctx)
        next = 'review'
        break
      case 'review':
        await runReviewStage(ctx)
        // Re-fetch: the user may have toggled illustrations while review ran.
        next = getProjectRow(ctx.projectId).illustrations ? 'illustrate' : 'export'
        break
      case 'illustrate':
        await runIllustrateStage(ctx)
        next = 'export'
        break
      case 'align':
        await runAlignStage(ctx)
        next = 'export'
        break
      case 'export':
        await runExportStage(ctx)
        next = 'done'
        break
      // Translation track (a derived project runs these instead of the above).
      case 'glossary':
        await runGlossaryStage(ctx)
        next = 'translate'
        break
      case 'translate':
        await runTranslateStage(ctx)
        next = 'tcheck'
        break
      case 'tcheck':
        await runTranslationCheckStage(ctx)
        next = 'done'
        break
      default:
        return
    }
    updateProject(ctx.projectId, { stage: next })
    emitStatus(ctx.projectId)
    if (next === 'done') return
  }
}

export function startPipeline(projectId: string): void {
  const project = getProjectRow(projectId)
  if (runs.has(projectId) || project.stage === 'done') return

  const abort = new AbortController()
  const state: RunState = { abort, intent: 'running' }
  runs.set(projectId, state)
  log('pipeline', `start project=${projectId} stage=${project.stage}`)
  notifyPipelineRunning(true)
  updateProject(projectId, { status: 'running', error: null })
  emitStatus(projectId)

  const ctx: StepContext = {
    projectId,
    signal: abort.signal,
    checkpoint: () => {
      if (state.intent === 'pausing') throw new PipelineInterrupted('paused')
      if (state.intent === 'cancelling') throw new PipelineInterrupted('cancelled')
    }
  }

  void (async () => {
    try {
      await runPipeline(ctx)
      updateProject(projectId, { status: 'done' })
      log('pipeline', `finished project=${projectId}`)
    } catch (err) {
      if (err instanceof PipelineInterrupted) {
        log('pipeline', `${err.kind} project=${projectId}`)
        updateProject(projectId, { status: err.kind })
      } else {
        logError('pipeline', `failed project=${projectId}`, err)
        const message = err instanceof Error ? err.message : String(err)
        updateProject(projectId, { status: 'error', error: message })
        sendEvent('pipeline:error', { projectId, stepKey: '', message })
      }
    } finally {
      runs.delete(projectId)
      notifyPipelineRunning(runs.size > 0)
      try {
        emitStatus(projectId)
      } catch {
        // project deleted while the run was winding down
      }
    }
  })()
}

export function pausePipeline(projectId: string): void {
  const run = runs.get(projectId)
  if (!run) return
  run.intent = 'pausing'
  run.abort.abort()
}

export function cancelPipeline(projectId: string): void {
  const run = runs.get(projectId)
  if (run) {
    run.intent = 'cancelling'
    run.abort.abort()
    return
  }
  try {
    const project = getProjectRow(projectId)
    if (project.status !== 'done' && project.stage !== 'done') {
      updateProject(projectId, { status: 'cancelled' })
      emitStatus(projectId)
    }
  } catch {
    // project already deleted
  }
}

export async function clarifySend(projectId: string, text: string): Promise<void> {
  await clarifyUserMessage(projectId, text)
}

export async function clarifyProceed(projectId: string): Promise<void> {
  const project = getProjectRow(projectId)
  if (project.stage === 'clarify') {
    updateProject(projectId, { stage: 'bible' })
    emitStatus(projectId)
  }
}

export { kickoffClarify }
