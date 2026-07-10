import { ReviewIssuesOutputSchema } from '@shared/schemas/reviewIssues'
import type { ReviewIssue } from '@shared/schemas/reviewIssues'
import { getChapterArtifacts, getCurrentContent } from '../../db/repo/artifacts'
import { addIssues, issuesForRound, markIssuesFixed, type IssueRow } from '../../db/repo/issues'
import { getProjectRow, updateProject } from '../../db/repo/projects'
import { getLlm } from '../../llm/provider'
import { getAppSettings } from '../../services/settings'
import { neighborSummaries, priorSummaries, storyPrefix, wholeBookText } from '../contextPack'
import { PROMPT_VERSION, chapterRewriteUser, reviewReadUser } from '../prompts'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'
import { runSummaryStep } from './chapterLoop'

const MAX_ROUNDS = 3
/**
 * Above this (rough) token estimate the whole-book read goes chunked. The
 * binding constraint is OUTPUT, not context: one issue list for a whole big
 * book plus adaptive thinking blows the output budget (observed on a 232k-token
 * book: every single-call attempt ended stop=max_tokens).
 */
export const SINGLE_CALL_TOKEN_LIMIT = 150_000
export const CHUNK_CHAPTERS = 10

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

/**
 * Whole-book consistency review: re-read everything, collect issues, rewrite
 * flagged chapters, re-summarize them, repeat until clean (bounded rounds).
 */
export async function runReviewStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const { plannerModel, drafterModel } = getAppSettings()
  const llm = getLlm()

  for (let round = project.review_round + 1; round <= MAX_ROUNDS; round++) {
    emitProgress(
      ctx.projectId,
      `review:r${round}:read`,
      `Re-reading the whole book (round ${round})`
    )
    const outlineJson = getCurrentContent(ctx.projectId, 'outline') ?? ''

    const { text: bookText } = wholeBookText(ctx.projectId)
    const estimatedTokens = bookText.length / 3

    if (estimatedTokens <= SINGLE_CALL_TOKEN_LIMIT) {
      await runStep(
        ctx,
        `review:r${round}:read`,
        // Deliberately NOT hashing the book text: mid-round rewrites change it, and the
        // read must stay skippable on resume within the same round.
        stepHash(PROMPT_VERSION, plannerModel, round),
        async (rec) => {
          const result = await llm.structured({
            model: plannerModel,
            system: storyPrefix(project),
            messages: [
              { role: 'user', content: reviewReadUser({ round, bookText, outlineJson }) }
            ],
            maxTokens: 24000,
            effort: 'high',
            schemaName: 'reviewIssues',
            schema: ReviewIssuesOutputSchema,
            onUsage: rec,
            signal: ctx.signal
          })
          return {
            sideEffect: () => addIssues(ctx.projectId, round, dedupeIssues(result.value.issues))
          }
        }
      )
    } else {
      // Chunked read for long books — ONE CHECKPOINT PER CHUNK, so a chunk
      // that succeeded is never re-run (or re-billed) when a later one fails.
      const chapters = getChapterArtifacts(ctx.projectId, 'chapter_final')
      const allSummaries = priorSummaries(ctx.projectId, Number.MAX_SAFE_INTEGER)
      const chunkCount = Math.ceil(chapters.length / CHUNK_CHAPTERS)

      for (let ci = 0; ci < chunkCount; ci++) {
        const chunkKey = `review:r${round}:read:c${String(ci + 1).padStart(2, '0')}`
        emitProgress(
          ctx.projectId,
          chunkKey,
          `Re-reading the whole book (round ${round}, part ${ci + 1} of ${chunkCount})`
        )
        await runStep(
          ctx,
          chunkKey,
          stepHash(PROMPT_VERSION, plannerModel, round, ci),
          async (rec) => {
            const chunk = chapters.slice(ci * CHUNK_CHAPTERS, (ci + 1) * CHUNK_CHAPTERS)
            const chunkText =
              `SUMMARIES OF THE WHOLE BOOK (context):\n${allSummaries}\n\n` +
              chunk.map((a) => `=== CHAPTER ${a.chapter} ===\n\n${a.content}`).join('\n\n')
            const result = await llm.structured({
              model: plannerModel,
              system: storyPrefix(project),
              messages: [
                {
                  role: 'user',
                  content: reviewReadUser({ round, bookText: chunkText, outlineJson })
                }
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
          }
        )
      }

      await runStep(
        ctx,
        `review:r${round}:collect`,
        stepHash(PROMPT_VERSION, round, chunkCount),
        async () => {
          // Current versions of review_chunk artifacts are this round's (each
          // round saves new versions over the same chunk indexes).
          const chunkArtifacts = getChapterArtifacts(ctx.projectId, 'review_chunk')
          const issues = chunkArtifacts.flatMap((a) => JSON.parse(a.content) as ReviewIssue[])
          return {
            sideEffect: () => addIssues(ctx.projectId, round, dedupeIssues(issues))
          }
        }
      )
    }

    const issues = issuesForRound(ctx.projectId, round)
    if (issues.length === 0) {
      updateProject(ctx.projectId, { review_round: round })
      return
    }

    // Clamp to real chapters — the reviewer model could hallucinate a chapter
    // number, which must not create phantom chapter_final artifacts.
    const maxChapter = project.chapter_count ?? Number.MAX_SAFE_INTEGER
    const flaggedChapters = [
      ...new Set(
        issues
          .map((i) => i.chapter)
          .filter((c): c is number => c != null && c >= 1 && c <= maxChapter)
      )
    ].sort((a, b) => a - b)

    for (const ch of flaggedChapters) {
      const chIssues = issues.filter((i) => i.chapter === ch)
      const issuesText = renderIssues(chIssues)
      const rewriteKey = `review:r${round}:rewrite:ch:${String(ch).padStart(2, '0')}`

      emitProgress(
        ctx.projectId,
        rewriteKey,
        `Fixing chapter ${ch} (round ${round})`,
        ch,
        project.chapter_count
      )
      await runStep(
        ctx,
        rewriteKey,
        stepHash(PROMPT_VERSION, plannerModel, round, ch, issuesText),
        async (rec, onToken) => {
          const currentText = getCurrentContent(ctx.projectId, 'chapter_final', ch) ?? ''
          const planJson = getCurrentContent(ctx.projectId, 'chapter_plan', ch) ?? ''
          const result = await llm.prose({
            model: plannerModel,
            system: storyPrefix(project),
            messages: [
              {
                role: 'user',
                content: chapterRewriteUser({
                  chapter: ch,
                  currentText,
                  planJson,
                  issues: issuesText,
                  neighborSummaries: neighborSummaries(ctx.projectId, ch)
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

      await runSummaryStep(
        ctx,
        `review:r${round}:resum:ch:${String(ch).padStart(2, '0')}`,
        stepHash(PROMPT_VERSION, drafterModel, round, ch),
        ch
      )
    }

    updateProject(ctx.projectId, { review_round: round })
  }
}
