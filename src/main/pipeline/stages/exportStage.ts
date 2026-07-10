import { BookMetaSchema } from '@shared/schemas/bookMeta'
import { getCurrentContent } from '../../db/repo/artifacts'
import { getProjectRow } from '../../db/repo/projects'
import { getLlm } from '../../llm/provider'
import { getAppSettings } from '../../services/settings'
import { storyPrefix } from '../contextPack'
import { PROMPT_VERSION, bookMetaUser } from '../prompts'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'

/** Final metadata (spoiler-free annotation, FB2 genre, pen name). The FB2 file itself is assembled on demand at save time. */
export async function runExportStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const { drafterModel } = getAppSettings()

  let bookTitle = project.title
  try {
    const outline = JSON.parse(getCurrentContent(ctx.projectId, 'outline') ?? '{}') as {
      bookTitle?: string
    }
    if (outline.bookTitle) bookTitle = outline.bookTitle
  } catch {
    // keep project title
  }
  const firstChapter = getCurrentContent(ctx.projectId, 'chapter_final', 1) ?? ''

  emitProgress(ctx.projectId, 'export:meta', 'Preparing the book file')
  await runStep(
    ctx,
    'export:meta',
    stepHash(PROMPT_VERSION, drafterModel, bookTitle, firstChapter),
    async (rec) => {
      const result = await getLlm().structured({
        model: drafterModel,
        system: storyPrefix(project),
        messages: [
          {
            role: 'user',
            content: bookMetaUser({
              title: bookTitle,
              genreHint: project.genre_hint,
              firstChapterText: firstChapter
            })
          }
        ],
        maxTokens: 6000,
        effort: 'low',
        schemaName: 'bookMeta',
        schema: BookMetaSchema,
        onUsage: rec,
        signal: ctx.signal
      })
      return {
        artifact: {
          kind: 'book_meta',
          chapter: null,
          content: JSON.stringify(result.value, null, 2)
        },
      }
    }
  )
}
