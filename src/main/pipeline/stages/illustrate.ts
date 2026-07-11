import { ImagePromptSchema, ImageStyleBlockSchema } from '@shared/schemas/imagePrompt'
import { getChapterArtifacts, getCurrentContent } from '../../db/repo/artifacts'
import { getImage, saveImage } from '../../db/repo/images'
import { getProjectRow } from '../../db/repo/projects'
import type { LlmUsage } from '../../llm/types'
import { getLlm } from '../../llm/provider'
import { generateImage } from '../../llm/openaiImages'
import { getAppSettings } from '../../services/settings'
import { characterVisuals, storyPrefix } from '../contextPack'
import { readWorldSeed } from '../worldSeed'
import { PROMPT_VERSION, imagePromptUser, imageStyleBlockUser } from '../prompts'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'

function imageUsage(costUsd: number, durationMs: number): LlmUsage {
  return {
    provider: 'openai',
    model: 'gpt-image-2',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    durationMs,
    stopReason: null
  }
}

/**
 * Style-locked illustrations. Spoiler-safe by construction: image prompts are
 * generated from the final reader prose only — never from plans or the ledger.
 * The cover anchors the style; every chapter image uses it as reference.
 */
export async function runIllustrateStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  if (!project.illustrations) return
  const { plannerModel, drafterModel } = getAppSettings()
  const llm = getLlm()

  emitProgress(ctx.projectId, 'img:style', 'Choosing the illustration style')
  const styleOverride = getCurrentContent(ctx.projectId, 'image_style_override')
  const seedStyleBlock = readWorldSeed(ctx.projectId)?.imageStyleBlock ?? null
  if (styleOverride) {
    // Edit variant restyle: the author supplied a text description that replaces
    // the locked art style outright. Checkpointed copy, no LLM call — mirrors the
    // seedStyleBlock branch exactly. Inert (never hashed/reached) unless an
    // 'image_style_override' artifact exists, so every existing book is unaffected.
    await runStep(
      ctx,
      'img:style',
      stepHash(PROMPT_VERSION, 'override', styleOverride),
      async () => ({
        artifact: { kind: 'image_style_block', chapter: null, content: styleOverride },
      })
    )
  } else if (seedStyleBlock) {
    // World reuse: keep the previous book's locked art style so the series
    // looks consistent. Checkpointed copy, no LLM call.
    await runStep(
      ctx,
      'img:style',
      stepHash(PROMPT_VERSION, 'seed-copy', seedStyleBlock),
      async () => ({
        artifact: { kind: 'image_style_block', chapter: null, content: seedStyleBlock },
      })
    )
  } else {
    await runStep(
      ctx,
      'img:style',
      stepHash(PROMPT_VERSION, plannerModel, project.genre_hint),
      async (rec) => {
        const result = await llm.structured({
          model: plannerModel,
          system: storyPrefix(project),
          messages: [{ role: 'user', content: imageStyleBlockUser(project.genre_hint) }],
          maxTokens: 4000,
          effort: 'medium',
          schemaName: 'imageStyleBlock',
          schema: ImageStyleBlockSchema,
          onUsage: rec,
          signal: ctx.signal
        })
        return {
          artifact: { kind: 'image_style_block', chapter: null, content: result.value.styleBlock },
        }
      }
    )
  }

  const styleBlock = getCurrentContent(ctx.projectId, 'image_style_block') ?? ''
  const visuals = characterVisuals(ctx.projectId)
  const chapters = getChapterArtifacts(ctx.projectId, 'chapter_final')
  const firstChapter = chapters.find((a) => a.chapter === 1)?.content ?? chapters[0]?.content ?? ''

  emitProgress(ctx.projectId, 'img:cover', 'Painting the cover')
  await runStep(ctx, 'img:cover', stepHash(PROMPT_VERSION, drafterModel, styleBlock), async (rec) => {
    const promptResult = await llm.structured({
      model: drafterModel,
      system: storyPrefix(project),
      messages: [
        {
          role: 'user',
          content: imagePromptUser({
            target: 'cover',
            chapter: null,
            readerText: firstChapter,
            characterVisuals: visuals
          })
        }
      ],
      maxTokens: 4000,
      effort: 'low',
      schemaName: 'imagePrompt',
      schema: ImagePromptSchema,
      onUsage: rec,
      signal: ctx.signal
    })

    const started = Date.now()
    const fullPrompt = `${styleBlock}\n\n${promptResult.value.prompt}`
    const img = await generateImage({
      prompt: fullPrompt,
      orientation: 'portrait',
      quality: 'high',
      signal: ctx.signal
    })
    rec(imageUsage(img.costUsd, Date.now() - started))

    return {
      artifact: { kind: 'image_prompt', chapter: null, content: fullPrompt },
      sideEffect: () => {
        saveImage(ctx.projectId, 'cover', null, fullPrompt, img.jpeg, img.width, img.height)
      }
    }
  })

  const coverRow = getImage(ctx.projectId, 'cover')
  const coverJpeg = coverRow?.jpeg ? Buffer.from(coverRow.jpeg) : undefined

  for (const chapterArtifact of chapters) {
    const ch = chapterArtifact.chapter
    if (ch == null) continue
    const key = `img:ch:${String(ch).padStart(2, '0')}`
    emitProgress(
      ctx.projectId,
      key,
      `Illustrating chapter ${ch} of ${chapters.length}`,
      ch,
      chapters.length
    )
    await runStep(ctx, key, stepHash(PROMPT_VERSION, drafterModel, ch, styleBlock), async (rec) => {
      const promptResult = await llm.structured({
        model: drafterModel,
        system: storyPrefix(project),
        messages: [
          {
            role: 'user',
            content: imagePromptUser({
              target: 'chapter',
              chapter: ch,
              readerText: chapterArtifact.content,
              characterVisuals: visuals
            })
          }
        ],
        maxTokens: 4000,
        effort: 'low',
        schemaName: 'imagePrompt',
        schema: ImagePromptSchema,
        onUsage: rec,
        signal: ctx.signal
      })

      const started = Date.now()
      const fullPrompt = `${styleBlock}\n\n${promptResult.value.prompt}`
      const img = await generateImage({
        prompt: fullPrompt,
        orientation: 'landscape',
        quality: 'medium',
        styleAnchor: coverJpeg,
        signal: ctx.signal
      })
      rec(imageUsage(img.costUsd, Date.now() - started))

      return {
        artifact: { kind: 'image_prompt', chapter: ch, content: fullPrompt },
        sideEffect: () => {
          saveImage(ctx.projectId, 'chapter', ch, fullPrompt, img.jpeg, img.width, img.height)
        }
      }
    })
  }
}
