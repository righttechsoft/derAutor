import { countWords } from '@shared/domain'
import { ReviewIssuesOutputSchema, type ReviewIssue } from '@shared/schemas/reviewIssues'
import { TranslationFrontMatterSchema } from '@shared/schemas/translation'
import { TranslationGlossarySchema } from '@shared/schemas/translation'
import { getChapterArtifacts, getCurrentContent, saveArtifact } from '../../db/repo/artifacts'
import { addIssues, issuesForRound, markIssuesFixed, type IssueRow } from '../../db/repo/issues'
import { getProjectRow, updateProject } from '../../db/repo/projects'
import { getLlm } from '../../llm/provider'
import { getAppSettings } from '../../services/settings'
import { previousTail, translationPrefix, wholeBookText } from '../contextPack'
import {
  PROMPT_VERSION,
  translationCheckReadUser,
  translationChapterUser,
  translationFrontMatterUser,
  translationGlossaryUser,
  translationRetranslateUser,
  translationSystem
} from '../prompts'
import { readTranslationSeed, type TranslationSeed } from '../translationSeed'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'
import { CHUNK_CHAPTERS, SINGLE_CALL_TOKEN_LIMIT } from './review'

const CHECK_MAX_ROUNDS = 2

function seedOf(projectId: string): TranslationSeed {
  const seed = readTranslationSeed(projectId)
  if (!seed) throw new Error('Translation seed missing — this project is not a translation.')
  return seed
}

function dedupeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const key = `${i.chapter}|${i.category}|${i.description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function renderIssues(rows: IssueRow[]): string {
  return rows
    .map((i) => `- [${i.severity}/${i.category}] ${i.description}\n  FIX: ${i.fix_instruction ?? ''}`)
    .join('\n')
}

/** Builds the names/terms vocabulary once, from the source world bible + characters. */
export async function runGlossaryStage(ctx: StepContext): Promise<void> {
  const seed = seedOf(ctx.projectId)
  const { plannerModel } = getAppSettings()
  const llm = getLlm()

  emitProgress(ctx.projectId, 'tr:glossary', 'Building the translation glossary')
  await runStep(
    ctx,
    'tr:glossary',
    stepHash(
      PROMPT_VERSION,
      plannerModel,
      seed.sourceLanguage,
      seed.targetLanguage,
      seed.worldBible,
      seed.charactersJson
    ),
    async (rec) => {
      const result = await llm.structured({
        model: plannerModel,
        system: [
          {
            text: translationSystem({
              sourceLanguage: seed.sourceLanguage,
              targetLanguage: seed.targetLanguage
            })
          }
        ],
        messages: [
          {
            role: 'user',
            content: translationGlossaryUser({
              sourceLanguage: seed.sourceLanguage,
              targetLanguage: seed.targetLanguage,
              worldBible: seed.worldBible,
              charactersJson: seed.charactersJson
            })
          }
        ],
        maxTokens: 16000,
        effort: 'high',
        schemaName: 'translationGlossary',
        schema: TranslationGlossarySchema,
        onUsage: rec,
        signal: ctx.signal
      })
      return {
        artifact: {
          kind: 'translation_glossary',
          chapter: null,
          content: JSON.stringify(result.value, null, 2)
        }
      }
    }
  )
}

/**
 * Translates the front matter (title, chapter titles, annotation) into the
 * project's own `outline`/`book_meta` artifacts, then every chapter's prose.
 */
export async function runTranslateStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const seed = seedOf(ctx.projectId)
  const { plannerModel } = getAppSettings()
  const llm = getLlm()
  const glossary = getCurrentContent(ctx.projectId, 'translation_glossary') ?? ''
  const prefix = translationPrefix(project, seed, glossary)

  // --- front matter: translated outline + book_meta ---
  const sourceAnnotation = (() => {
    if (!seed.bookMetaJson) return ''
    try {
      return (JSON.parse(seed.bookMetaJson) as { annotation?: string }).annotation ?? ''
    } catch {
      return ''
    }
  })()

  emitProgress(ctx.projectId, 'tr:frontmatter', 'Translating the title and chapter headings')
  await runStep(
    ctx,
    'tr:frontmatter',
    stepHash(PROMPT_VERSION, plannerModel, 'frontmatter', seed.outlineJson, seed.bookMetaJson ?? ''),
    async (rec) => {
      const chapterTitlesText = seed.chapters.map((c) => `${c.chapter}: ${c.title}`).join('\n')
      const result = await llm.structured({
        model: plannerModel,
        system: prefix,
        messages: [
          {
            role: 'user',
            content: translationFrontMatterUser({
              chapterCount: seed.chapters.length,
              bookTitle: seed.sourceBookTitle,
              chapterTitlesText,
              annotation: sourceAnnotation
            })
          }
        ],
        maxTokens: 8000,
        effort: 'medium',
        schemaName: 'translationFrontMatter',
        schema: TranslationFrontMatterSchema,
        onUsage: rec,
        signal: ctx.signal
      })

      // Translated outline: clone the source outline, swap in translated title +
      // chapter titles. Only bookTitle + chapters[].title are read by the FB2
      // exporter; the rest is carried over verbatim for the author's room.
      const translatedTitle = new Map(result.value.chapterTitles.map((t) => [t.index, t.title]))
      const outline = JSON.parse(seed.outlineJson) as {
        bookTitle?: string
        chapters?: { index?: number; title?: string }[]
      }
      outline.bookTitle = result.value.bookTitle
      for (const ch of outline.chapters ?? []) {
        if (typeof ch.index === 'number' && translatedTitle.has(ch.index)) {
          ch.title = translatedTitle.get(ch.index)
        }
      }

      // Translated book_meta: translated annotation, source genre + pseudonym kept.
      let fb2Genre = 'prose_contemporary'
      let authorPseudonym = 'derAutor'
      if (seed.bookMetaJson) {
        try {
          const src = JSON.parse(seed.bookMetaJson) as { fb2Genre?: string; authorPseudonym?: string }
          if (src.fb2Genre) fb2Genre = src.fb2Genre
          if (src.authorPseudonym) authorPseudonym = src.authorPseudonym
        } catch {
          // keep defaults
        }
      }
      const bookMeta = { annotation: result.value.annotation, fb2Genre, authorPseudonym }

      return {
        artifact: { kind: 'outline', chapter: null, content: JSON.stringify(outline, null, 2) },
        sideEffect: () =>
          saveArtifact(ctx.projectId, 'book_meta', null, JSON.stringify(bookMeta, null, 2))
      }
    }
  )

  // --- per-chapter prose ---
  const total = seed.chapters.length
  for (const sc of seed.chapters) {
    const ch = sc.chapter
    const approxWords = countWords(sc.content)
    const prevTargetTail = previousTail(ctx.projectId, ch)

    emitProgress(ctx.projectId, trKey(ch), `Translating chapter ${ch} of ${total}`, ch, total)
    await runStep(
      ctx,
      trKey(ch),
      stepHash(PROMPT_VERSION, plannerModel, ch, sc.content, glossary),
      async (rec, onToken) => {
        const result = await llm.prose({
          model: plannerModel,
          system: prefix,
          messages: [
            {
              role: 'user',
              content: translationChapterUser({
                chapter: ch,
                approxWords,
                sourceText: sc.content,
                prevTargetTail
              })
            }
          ],
          maxTokens: 24000,
          effort: 'high',
          onToken,
          onUsage: rec,
          signal: ctx.signal
        })
        return { artifact: { kind: 'chapter_final', chapter: ch, content: result.text } }
      }
    )
  }
}

/**
 * Consistency check: re-read the translation, find translation problems, and
 * re-translate the chapters with major/critical issues. Mirrors the review
 * stage (chunked read for long books, one checkpoint per chunk), reusing the
 * review_issues table. No re-summary step — translations carry no ledger.
 */
export async function runTranslationCheckStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const seed = seedOf(ctx.projectId)
  const { plannerModel } = getAppSettings()
  const llm = getLlm()
  const glossary = getCurrentContent(ctx.projectId, 'translation_glossary') ?? ''
  const prefix = translationPrefix(project, seed, glossary)

  for (let round = project.review_round + 1; round <= CHECK_MAX_ROUNDS; round++) {
    emitProgress(ctx.projectId, `tcheck:r${round}:read`, `Checking the translation (round ${round})`)
    const { text: bookText } = wholeBookText(ctx.projectId)
    const estimatedTokens = bookText.length / 3

    if (estimatedTokens <= SINGLE_CALL_TOKEN_LIMIT) {
      await runStep(
        ctx,
        `tcheck:r${round}:read`,
        // Not hashing the book text: mid-round re-translations change it and the
        // read must stay skippable on resume within the same round (as in review).
        stepHash(PROMPT_VERSION, plannerModel, round),
        async (rec) => {
          const result = await llm.structured({
            model: plannerModel,
            system: prefix,
            messages: [{ role: 'user', content: translationCheckReadUser({ round, bookText, glossary }) }],
            maxTokens: 24000,
            effort: 'high',
            schemaName: 'reviewIssues',
            schema: ReviewIssuesOutputSchema,
            onUsage: rec,
            signal: ctx.signal
          })
          return { sideEffect: () => addIssues(ctx.projectId, round, dedupeIssues(result.value.issues)) }
        }
      )
    } else {
      const chapters = getChapterArtifacts(ctx.projectId, 'chapter_final')
      const chunkCount = Math.ceil(chapters.length / CHUNK_CHAPTERS)
      for (let ci = 0; ci < chunkCount; ci++) {
        const chunkKey = `tcheck:r${round}:read:c${String(ci + 1).padStart(2, '0')}`
        emitProgress(
          ctx.projectId,
          chunkKey,
          `Checking the translation (round ${round}, part ${ci + 1} of ${chunkCount})`
        )
        await runStep(ctx, chunkKey, stepHash(PROMPT_VERSION, plannerModel, round, ci), async (rec) => {
          const chunk = chapters.slice(ci * CHUNK_CHAPTERS, (ci + 1) * CHUNK_CHAPTERS)
          const chunkText = chunk.map((a) => `=== CHAPTER ${a.chapter} ===\n\n${a.content}`).join('\n\n')
          const result = await llm.structured({
            model: plannerModel,
            system: prefix,
            messages: [
              { role: 'user', content: translationCheckReadUser({ round, bookText: chunkText, glossary }) }
            ],
            maxTokens: 32000,
            effort: 'high',
            schemaName: 'reviewIssues',
            schema: ReviewIssuesOutputSchema,
            onUsage: rec,
            signal: ctx.signal
          })
          return {
            artifact: {
              kind: 'review_chunk',
              chapter: ci + 1,
              content: JSON.stringify(result.value.issues)
            }
          }
        })
      }
      await runStep(
        ctx,
        `tcheck:r${round}:collect`,
        stepHash(PROMPT_VERSION, round, chunkCount),
        async () => {
          const chunkArtifacts = getChapterArtifacts(ctx.projectId, 'review_chunk')
          const issues = chunkArtifacts.flatMap((a) => JSON.parse(a.content) as ReviewIssue[])
          return { sideEffect: () => addIssues(ctx.projectId, round, dedupeIssues(issues)) }
        }
      )
    }

    const issues = issuesForRound(ctx.projectId, round)
    const maxChapter = project.chapter_count ?? Number.MAX_SAFE_INTEGER
    // Only re-translate chapters carrying a major/critical issue.
    const flaggedChapters = [
      ...new Set(
        issues
          .filter((i) => i.severity === 'major' || i.severity === 'critical')
          .map((i) => i.chapter)
          .filter((c): c is number => c != null && c >= 1 && c <= maxChapter)
      )
    ].sort((a, b) => a - b)

    if (flaggedChapters.length === 0) {
      updateProject(ctx.projectId, { review_round: round })
      return
    }

    for (const ch of flaggedChapters) {
      const chIssues = issues.filter((i) => i.chapter === ch)
      const issuesText = renderIssues(chIssues)
      const sc = seed.chapters.find((c) => c.chapter === ch)
      const fixKey = `tcheck:r${round}:fix:ch:${String(ch).padStart(2, '0')}`
      emitProgress(ctx.projectId, fixKey, `Refining chapter ${ch} (round ${round})`, ch, project.chapter_count)
      await runStep(
        ctx,
        fixKey,
        stepHash(PROMPT_VERSION, plannerModel, round, ch, issuesText),
        async (rec, onToken) => {
          const currentText = getCurrentContent(ctx.projectId, 'chapter_final', ch) ?? ''
          const result = await llm.prose({
            model: plannerModel,
            system: prefix,
            messages: [
              {
                role: 'user',
                content: translationRetranslateUser({
                  chapter: ch,
                  approxWords: sc ? countWords(sc.content) : countWords(currentText),
                  sourceText: sc?.content ?? '',
                  currentText,
                  issues: issuesText
                })
              }
            ],
            maxTokens: 24000,
            effort: 'high',
            onToken,
            onUsage: rec,
            signal: ctx.signal
          })
          return {
            artifact: { kind: 'chapter_final', chapter: ch, content: result.text },
            sideEffect: () => markIssuesFixed(ctx.projectId, round, ch)
          }
        }
      )
    }

    updateProject(ctx.projectId, { review_round: round })
  }
}

function trKey(ch: number): string {
  return `tr:ch:${String(ch).padStart(2, '0')}`
}
