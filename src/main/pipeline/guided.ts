import type { ArtifactKind, GuidedPending } from '@shared/domain'
import type { ZodType } from 'zod'
import { ClarifyBriefSchema } from '@shared/schemas/clarify'
import { CharactersOutputSchema } from '@shared/schemas/characters'
import { OutlineSchema } from '@shared/schemas/outline'
import { ChapterPlanSchema } from '@shared/schemas/chapterPlan'
import { SummaryLedgerSchema } from '@shared/schemas/summaryLedger'
import { BookMetaSchema } from '@shared/schemas/bookMeta'
import { ImagePromptSchema, ImageStyleBlockSchema } from '@shared/schemas/imagePrompt'
import { ReviewIssuesOutputSchema } from '@shared/schemas/reviewIssues'
import { TranslationGlossarySchema } from '@shared/schemas/translation'
import { inTransaction } from '../db/database'
import {
  getArtifactById,
  getCurrentContent,
  saveArtifact
} from '../db/repo/artifacts'
import { addGuidedMessage, getGuidedMessages } from '../db/repo/guidedMessages'
import { getJob, markJobFailed } from '../db/repo/jobs'
import { getProjectRow, updateProject } from '../db/repo/projects'
import { recordLlmCall } from '../db/repo/usage'
import { getLlm } from '../llm/provider'
import type { LlmUsage, SystemBlock } from '../llm/types'
import { getAppSettings } from '../services/settings'
import { sendEvent } from '../ipc/events'
import { logError } from '../services/logger'
import { emitCost, emitGuidedToken } from './engine'
import { neighborSummaries, storyPrefix, translationPrefix } from './contextPack'
import { guidedReviseProseUser, guidedReviseStructuredUser } from './prompts'
import { readTranslationSeed } from './translationSeed'
import { startPipeline } from './controller'

/** How each artifact kind is (re)generated, so refine can drive the right call. */
type GenSpec =
  | { mode: 'prose' }
  | { mode: 'structured'; schemaName: string; schema: ZodType<unknown> }

const KIND_GEN: Partial<Record<ArtifactKind, GenSpec>> = {
  clarify_brief: { mode: 'structured', schemaName: 'clarifyBrief', schema: ClarifyBriefSchema },
  world_bible: { mode: 'prose' },
  characters: { mode: 'structured', schemaName: 'characters', schema: CharactersOutputSchema },
  outline: { mode: 'structured', schemaName: 'outline', schema: OutlineSchema },
  style_guide: { mode: 'prose' },
  chapter_plan: { mode: 'structured', schemaName: 'chapterPlan', schema: ChapterPlanSchema },
  chapter_final: { mode: 'prose' },
  chapter_summary: { mode: 'structured', schemaName: 'summaryLedger', schema: SummaryLedgerSchema },
  book_meta: { mode: 'structured', schemaName: 'bookMeta', schema: BookMetaSchema },
  image_prompt: { mode: 'structured', schemaName: 'imagePrompt', schema: ImagePromptSchema },
  image_style_block: { mode: 'structured', schemaName: 'imageStyleBlock', schema: ImageStyleBlockSchema },
  review_chunk: { mode: 'structured', schemaName: 'reviewIssues', schema: ReviewIssuesOutputSchema },
  translation_glossary: { mode: 'structured', schemaName: 'translationGlossary', schema: TranslationGlossarySchema }
}

const KIND_LABEL: Partial<Record<ArtifactKind, string>> = {
  clarify_brief: 'clarification brief',
  world_bible: 'world bible',
  characters: 'character sheets',
  outline: 'outline',
  style_guide: 'style guide',
  chapter_plan: 'chapter plan',
  chapter_final: 'chapter',
  chapter_summary: 'chapter summary',
  book_meta: 'book metadata',
  image_prompt: 'image prompt',
  image_style_block: 'image style',
  review_chunk: 'review notes',
  translation_glossary: 'translation glossary'
}

function labelFor(kind: ArtifactKind, chapter: number | null): string {
  const base = KIND_LABEL[kind] ?? kind
  return chapter != null ? `Chapter ${chapter} — ${base}` : base.charAt(0).toUpperCase() + base.slice(1)
}

/** Resolves the (kind, chapter) of the step currently awaiting a decision. */
function pendingTarget(projectId: string): { stepKey: string; kind: ArtifactKind; chapter: number | null } | null {
  const project = getProjectRow(projectId)
  const stepKey = project.pending_step
  if (!stepKey) return null
  const job = getJob(projectId, stepKey)
  if (!job?.result_artifact_id) return null
  const art = getArtifactById(projectId, job.result_artifact_id)
  if (!art) return null
  return { stepKey, kind: art.kind, chapter: art.chapter }
}

export function guidedCurrent(projectId: string): GuidedPending | null {
  const target = pendingTarget(projectId)
  if (!target) return null
  const project = getProjectRow(projectId)
  const content = getCurrentContent(projectId, target.kind, target.chapter) ?? ''
  return {
    stepKey: target.stepKey,
    stage: project.stage,
    kind: target.kind,
    chapter: target.chapter,
    content,
    label: labelFor(target.kind, target.chapter),
    messages: getGuidedMessages(projectId, target.stepKey).map((m) => ({ role: m.role, content: m.content }))
  }
}

/** Approve the pending step and let the pipeline run the next one. */
export function guidedApprove(projectId: string): void {
  startPipeline(projectId)
}

/** Discard the pending step's draft and re-run it (a fresh generation from the same inputs). */
export function guidedRegenerate(projectId: string): void {
  const stepKey = getProjectRow(projectId).pending_step
  if (stepKey) markJobFailed(projectId, stepKey, 'regenerate requested (guided)')
  startPipeline(projectId)
}

/** Replace the pending step's artifact with the author's hand-edited version (does not resume). */
export function guidedEdit(projectId: string, content: string): GuidedPending | null {
  const target = pendingTarget(projectId)
  if (!target) return null
  inTransaction(() => {
    saveArtifact(projectId, target.kind, target.chapter, content)
  })
  addGuidedMessage(projectId, target.stepKey, 'assistant', 'Applied the author’s manual edit.')
  return guidedCurrent(projectId)
}

/** Turn guided mode off and run the rest of the pipeline straight to done. */
export function guidedRunFree(projectId: string): void {
  updateProject(projectId, { guided: 0, pending_step: null })
  startPipeline(projectId)
}

const refining = new Set<string>()

function reviserSystem(projectId: string): SystemBlock[] {
  const project = getProjectRow(projectId)
  const seed = readTranslationSeed(projectId)
  if (seed) {
    const glossary = getCurrentContent(projectId, 'translation_glossary') ?? ''
    return translationPrefix(project, seed, glossary)
  }
  return storyPrefix(project)
}

/** Extra context that helps revise specific kinds (e.g. the chapter plan for prose). */
function reviseExtraContext(projectId: string, kind: ArtifactKind, chapter: number | null): string {
  if (kind === 'chapter_final' && chapter != null) {
    const plan = getCurrentContent(projectId, 'chapter_plan', chapter)
    const neighbors = neighborSummaries(projectId, chapter)
    return [
      plan ? `CHAPTER PLAN (hidden blueprint):\n${plan}` : '',
      neighbors ? `NEIGHBOURING CHAPTERS (summaries):\n${neighbors}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

/**
 * One interactive refine turn on the pending step: the author's message steers a
 * revision of the current artifact, streamed (prose) or validated (structured),
 * saved as a new version. Does not resume the pipeline — the step stays pending.
 */
export async function guidedRefine(projectId: string, message: string): Promise<void> {
  if (refining.has(projectId)) {
    sendEvent('guided:error', { projectId, message: 'Still working on the previous request — give it a moment.' })
    return
  }
  const target = pendingTarget(projectId)
  if (!target) throw new Error('Nothing is awaiting refinement.')
  const gen = KIND_GEN[target.kind]
  if (!gen) throw new Error(`This step (${target.kind}) cannot be refined.`)

  refining.add(projectId)
  try {
    const { plannerModel } = getAppSettings()
    const llm = getLlm()
    const label = KIND_LABEL[target.kind] ?? target.kind
    const current = getCurrentContent(projectId, target.kind, target.chapter) ?? ''
    const earlierRequests = getGuidedMessages(projectId, target.stepKey)
      .filter((m) => m.role === 'user')
      .map((m) => `- ${m.content}`)
      .join('\n')
    addGuidedMessage(projectId, target.stepKey, 'user', message)
    const system = reviserSystem(projectId)

    let content: string
    let usage: LlmUsage
    if (gen.mode === 'prose') {
      const result = await llm.prose({
        model: plannerModel,
        system,
        messages: [
          {
            role: 'user',
            content: guidedReviseProseUser({
              label,
              currentText: current,
              message,
              earlierRequests,
              extraContext: reviseExtraContext(projectId, target.kind, target.chapter)
            })
          }
        ],
        maxTokens: 24000,
        effort: 'high',
        onToken: (delta) => emitGuidedToken(projectId, delta)
      })
      content = result.text
      usage = result.usage
    } else {
      const result = await llm.structured({
        model: plannerModel,
        system,
        messages: [
          {
            role: 'user',
            content: guidedReviseStructuredUser({
              label,
              currentJson: current,
              message,
              earlierRequests
            })
          }
        ],
        maxTokens: 16000,
        effort: 'high',
        schemaName: gen.schemaName,
        schema: gen.schema
      })
      content = JSON.stringify(result.value, null, 2)
      usage = result.usage
    }

    inTransaction(() => {
      saveArtifact(projectId, target.kind, target.chapter, content)
    })
    addGuidedMessage(projectId, target.stepKey, 'assistant', `Revised the ${label}.`)

    recordLlmCall({
      projectId,
      jobId: target.stepKey,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      durationMs: usage.durationMs,
      stopReason: usage.stopReason
    })
    emitCost(projectId)
  } finally {
    refining.delete(projectId)
  }
}

export function guidedRefineSafe(projectId: string, message: string): Promise<void> {
  return guidedRefine(projectId, message).catch((err) => {
    logError('guided', `refine failed project=${projectId}`, err)
    sendEvent('guided:error', {
      projectId,
      message: err instanceof Error ? err.message : String(err)
    })
  })
}
