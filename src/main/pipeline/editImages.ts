import { ImagePromptSchema } from '@shared/schemas/imagePrompt'
import { inTransaction } from '../db/database'
import { getChapterArtifacts, getCurrentContent, saveArtifact } from '../db/repo/artifacts'
import { getImage, saveImage } from '../db/repo/images'
import { getProjectRow, updateProject } from '../db/repo/projects'
import { recordLlmCall } from '../db/repo/usage'
import { getLlm } from '../llm/provider'
import type { LlmUsage } from '../llm/types'
import { generateImage } from '../llm/openaiImages'
import { getAppSettings } from '../services/settings'
import { characterVisuals, storyPrefix } from './contextPack'
import { startPipeline } from './controller'
import { emitCost } from './engine'
import { imagePromptUser } from './prompts'

/**
 * Out-of-engine image editing for finished edit variants: fix one chapter's
 * illustration, or restyle every image from a new text description. Runs OUT
 * of the engine — synchronous, user-driven, like editBook.ts — so fixImage
 * writes no jobs rows. restyleImagesText delegates the actual repainting to
 * the engine (via startPipeline), which is the correct place for a multi-step,
 * resumable run.
 */

function imageUsage(costUsd: number, durationMs: number): LlmUsage {
  return {
    provider: 'openai',
    model: 'gpt-image-1',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    durationMs,
    stopReason: null
  }
}

function recordUsage(projectId: string, stepKey: string, usage: LlmUsage): void {
  recordLlmCall({
    projectId,
    jobId: stepKey,
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
}

function requireEditVariant(projectId: string) {
  const project = getProjectRow(projectId)
  if (project.edit_copy !== 1) {
    throw new Error('Not an edit variant — edits can never target a finished book directly')
  }
  return project
}

/** Re-renders one chapter's illustration, optionally steered by a fix instruction. */
export async function fixImage(
  projectId: string,
  chapter: number,
  instruction?: string
): Promise<{ chapter: number; dataUrl: string }> {
  const project = requireEditVariant(projectId)
  const styleBlock = getCurrentContent(projectId, 'image_style_block') ?? ''

  let fullPrompt = getCurrentContent(projectId, 'image_prompt', chapter)
  if (!fullPrompt) {
    // No stored prompt to reuse (e.g. illustrations were off originally) — build
    // one fresh from the chapter's reader prose, mirroring illustrate.ts's chapter branch.
    const chapterArtifact = getChapterArtifacts(projectId, 'chapter_final').find(
      (a) => a.chapter === chapter
    )
    if (!chapterArtifact) throw new Error(`Chapter ${chapter} has no prose to illustrate`)
    const { drafterModel } = getAppSettings()
    const promptResult = await getLlm().structured({
      model: drafterModel,
      system: storyPrefix(project),
      messages: [
        {
          role: 'user',
          content: imagePromptUser({
            target: 'chapter',
            chapter,
            readerText: chapterArtifact.content,
            characterVisuals: characterVisuals(projectId)
          })
        }
      ],
      maxTokens: 4000,
      effort: 'low',
      schemaName: 'imagePrompt',
      schema: ImagePromptSchema
    })
    recordUsage(projectId, `edit:img:ch:${chapter}:prompt`, promptResult.usage)
    fullPrompt = `${styleBlock}\n\n${promptResult.value.prompt}`
  }
  if (instruction) fullPrompt = `${fullPrompt}\n\nAuthor's fix: ${instruction}`

  const coverRow = getImage(projectId, 'cover')
  const coverJpeg = coverRow?.jpeg ? Buffer.from(coverRow.jpeg) : undefined

  const started = Date.now()
  const img = await generateImage({
    prompt: fullPrompt,
    orientation: 'landscape',
    quality: 'medium',
    styleAnchor: coverJpeg
  })
  recordUsage(projectId, `edit:img:ch:${chapter}`, imageUsage(img.costUsd, Date.now() - started))

  inTransaction(() => {
    saveImage(projectId, 'chapter', chapter, fullPrompt as string, img.jpeg, img.width, img.height)
    saveArtifact(projectId, 'image_prompt', chapter, fullPrompt as string)
  })
  emitCost(projectId)

  return {
    chapter,
    dataUrl: `data:image/jpeg;base64,${Buffer.from(img.jpeg).toString('base64')}`
  }
}

/**
 * Overwrites the locked art style from a text description and re-enters the
 * illustrate stage to repaint the cover and every chapter under it.
 */
export function restyleImagesText(projectId: string, style: string): void {
  const project = requireEditVariant(projectId)

  inTransaction(() => {
    saveArtifact(projectId, 'image_style_override', null, style)
    if (!project.illustrations) updateProject(projectId, { illustrations: 1 })
    updateProject(projectId, { stage: 'illustrate', status: 'paused' })
  })
  startPipeline(projectId)
}
