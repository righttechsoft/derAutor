import { deriveChapterCount } from '@shared/domain'
import { ClarifyBriefSchema } from '@shared/schemas/clarify'
import { CharactersOutputSchema } from '@shared/schemas/characters'
import { OutlineSchema } from '@shared/schemas/outline'
import { getCurrentContent } from '../../db/repo/artifacts'
import { getClarifyHistory } from '../../db/repo/clarify'
import { getProjectRow, updateProject } from '../../db/repo/projects'
import { getLlm } from '../../llm/provider'
import { getAppSettings } from '../../services/settings'
import { clarifyPrefix, seedBibleBase, seedPrefix } from '../contextPack'
import { readWorldSeed, renderSeedSummaries } from '../worldSeed'
import {
  PROMPT_VERSION,
  charactersSequelUser,
  charactersUser,
  clarifyBriefUser,
  outlineUser,
  styleGuideUser,
  worldBibleUpdateUser,
  worldBibleUser
} from '../prompts'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'

/** Story backbone: clarify brief → world bible → characters → outline → style guide. All hidden. */
export async function runBibleStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const { plannerModel } = getAppSettings()
  const llm = getLlm()
  // Seeded projects (world reuse) swap the prefix and the world/characters/style
  // steps; the seed is frozen at creation, so the branch and every hash derived
  // from it are stable across resume. Non-seeded hashes stay byte-identical.
  const seed = readWorldSeed(ctx.projectId)
  const prefix = seed ? seedPrefix(project, seed) : clarifyPrefix(project)

  const transcript = getClarifyHistory(ctx.projectId)
    .map((m) => `${m.role === 'user' ? 'AUTHOR' : 'EDITOR'}: ${m.content}`)
    .join('\n\n')

  emitProgress(ctx.projectId, 'bible:brief', 'Consolidating the world interview')
  await runStep(ctx, 'bible:brief', stepHash(PROMPT_VERSION, plannerModel, transcript), async (rec) => {
    const result = await llm.structured({
      model: plannerModel,
      system: prefix,
      messages: [
        {
          role: 'user',
          content: `INTERVIEW TRANSCRIPT:\n${transcript || '(the author skipped the interview)'}\n\n${clarifyBriefUser()}`
        }
      ],
      maxTokens: 10000,
      effort: 'high',
      schemaName: 'clarifyBrief',
      schema: ClarifyBriefSchema,
      onUsage: rec,
      signal: ctx.signal
    })
    return {
      artifact: {
        kind: 'clarify_brief',
        chapter: null,
        content: JSON.stringify(result.value, null, 2)
      },
    }
  })

  const brief = getCurrentContent(ctx.projectId, 'clarify_brief') ?? ''

  emitProgress(ctx.projectId, 'bible:world', 'Building the world bible')
  const worldHash = seed
    ? stepHash(PROMPT_VERSION, plannerModel, brief, JSON.stringify(seed))
    : stepHash(PROMPT_VERSION, plannerModel, brief)
  await runStep(ctx, 'bible:world', worldHash, async (rec, onToken) => {
    const result = await llm.prose({
      model: plannerModel,
      system: prefix,
      messages: [
        {
          role: 'user',
          content: seed
            ? worldBibleUpdateUser({ brief, summariesText: renderSeedSummaries(seed) })
            : worldBibleUser(brief)
        }
      ],
      maxTokens: 16000,
      effort: 'high',
      onToken,
      onUsage: rec,
      signal: ctx.signal
    })
    return {
      artifact: { kind: 'world_bible', chapter: null, content: result.text },
    }
  })

  const worldBible = getCurrentContent(ctx.projectId, 'world_bible') ?? ''
  // Post-world: the inherited bible/ledger leave the context — the rewritten
  // world bible replaces them (two world bibles invite stale facts).
  const bibleBase = seed ? seedBibleBase(project, seed) : prefix
  const bibleSystem = [...bibleBase, { text: `# WORLD BIBLE\n${worldBible}` }]

  emitProgress(ctx.projectId, 'bible:characters', 'Unfolding the characters')
  const charactersHash = seed
    ? stepHash(PROMPT_VERSION, plannerModel, worldBible, seed.charactersJson)
    : stepHash(PROMPT_VERSION, plannerModel, worldBible)
  await runStep(
    ctx,
    'bible:characters',
    charactersHash,
    async (rec) => {
      const result = await llm.structured({
        model: plannerModel,
        system: bibleSystem,
        messages: [
          {
            role: 'user',
            content: seed
              ? charactersSequelUser({ seedCharactersJson: seed.charactersJson })
              : charactersUser()
          }
        ],
        maxTokens: 16000,
        effort: 'high',
        schemaName: 'characters',
        schema: CharactersOutputSchema,
        onUsage: rec,
        signal: ctx.signal
      })
      return {
        artifact: {
          kind: 'characters',
          chapter: null,
          content: JSON.stringify(result.value, null, 2)
        },
      }
    }
  )

  const characters = getCurrentContent(ctx.projectId, 'characters') ?? ''
  const chapterCount = deriveChapterCount(project.target_words)
  const wordsPerChapter = Math.round(project.target_words / chapterCount)

  emitProgress(ctx.projectId, 'bible:outline', 'Designing the main storyline')
  await runStep(
    ctx,
    'bible:outline',
    stepHash(PROMPT_VERSION, plannerModel, worldBible, characters, chapterCount, wordsPerChapter),
    async (rec) => {
      const result = await llm.structured({
        model: plannerModel,
        system: [...bibleSystem, { text: `# CHARACTER SHEETS\n${characters}` }],
        messages: [
          {
            role: 'user',
            content: outlineUser({
              chapterCount,
              wordsPerChapter,
              targetWords: project.target_words
            })
          }
        ],
        maxTokens: 16000,
        effort: 'xhigh',
        schemaName: 'outline',
        schema: OutlineSchema,
        onUsage: rec,
        signal: ctx.signal
      })
      return {
        artifact: {
          kind: 'outline',
          chapter: null,
          content: JSON.stringify(result.value, null, 2)
        },
        sideEffect: () => {
          updateProject(ctx.projectId, { chapter_count: result.value.chapters.length })
        }
      }
    }
  )

  emitProgress(ctx.projectId, 'bible:style', 'Locking the narrative voice')
  if (seed && seed.language === project.language) {
    // Same language as the previous book: copy its style guide verbatim — the
    // series keeps one voice, and there is nothing to pay an LLM for.
    await runStep(
      ctx,
      'bible:style',
      stepHash(PROMPT_VERSION, 'seed-copy', seed.styleGuide),
      async () => ({
        artifact: { kind: 'style_guide', chapter: null, content: seed.styleGuide },
      })
    )
  } else {
    await runStep(ctx, 'bible:style', stepHash(PROMPT_VERSION, plannerModel, worldBible), async (rec, onToken) => {
      const result = await llm.prose({
        model: plannerModel,
        system: bibleSystem,
        messages: [{ role: 'user', content: styleGuideUser({ language: project.language, style: project.style_input }) }],
        maxTokens: 8000,
        effort: 'high',
        onToken,
        onUsage: rec,
        signal: ctx.signal
      })
      return {
        artifact: { kind: 'style_guide', chapter: null, content: result.text },
      }
    })
  }

  // Safety net: chapter_count is set inside the outline step's transaction, but if an
  // old checkpoint was replayed, derive it from the stored outline.
  if (getProjectRow(ctx.projectId).chapter_count == null) {
    const outline = JSON.parse(getCurrentContent(ctx.projectId, 'outline') ?? '{}') as {
      chapters?: unknown[]
    }
    updateProject(ctx.projectId, { chapter_count: outline.chapters?.length ?? chapterCount })
  }
}
