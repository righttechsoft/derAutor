import { countWords } from '@shared/domain'
import { ChapterPlanSchema } from '@shared/schemas/chapterPlan'
import { OutlineSchema } from '@shared/schemas/outline'
import { SummaryLedgerSchema } from '@shared/schemas/summaryLedger'
import { getCurrentContent, saveArtifact } from '../../db/repo/artifacts'
import { getProjectRow } from '../../db/repo/projects'
import { getLlm } from '../../llm/provider'
import { getAppSettings } from '../../services/settings'
import {
  priorSummaries,
  readLedger,
  renderLedger,
  previousTail,
  storyPrefix,
  type LedgerEntry
} from '../contextPack'
import { PROMPT_VERSION, chapterPlanUser, chapterProseUser, summaryLedgerUser } from '../prompts'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'
import type { SummaryLedger } from '@shared/schemas/summaryLedger'

function chKey(ch: number, part: string): string {
  return `ch:${String(ch).padStart(2, '0')}:${part}`
}

export function mergeLedger(projectId: string, chapter: number, value: SummaryLedger): void {
  const entries = readLedger(projectId)
  const additions: LedgerEntry[] = value.ledgerUpdates.map((u) => ({
    fact: u.fact,
    kind: u.kind,
    chapter,
    ...(u.op === 'amend' ? { supersedes: 'amends an earlier entry it contradicts' } : {})
  }))
  saveArtifact(projectId, 'ledger', null, JSON.stringify([...entries, ...additions], null, 2))
}

/** Runs plan → prose → summary+ledger for one chapter's summary step. Shared with the review rewrite path. */
export async function runSummaryStep(
  ctx: StepContext,
  stepKey: string,
  inputHash: string,
  chapter: number
): Promise<void> {
  const { drafterModel } = getAppSettings()
  const project = getProjectRow(ctx.projectId)
  await runStep(ctx, stepKey, inputHash, async (rec) => {
    const proseText = getCurrentContent(ctx.projectId, 'chapter_final', chapter) ?? ''
    const result = await getLlm().structured({
      model: drafterModel,
      system: storyPrefix(project),
      messages: [{ role: 'user', content: summaryLedgerUser({ chapter, proseText }) }],
      maxTokens: 8000,
      effort: 'low',
      schemaName: 'summaryLedger',
      schema: SummaryLedgerSchema,
      onUsage: rec,
      signal: ctx.signal
    })
    return {
      artifact: {
        kind: 'chapter_summary',
        chapter,
        content: `${result.value.summary}\n\n(in-story time elapsed: ${result.value.timeDelta})`
      },
      sideEffect: () => mergeLedger(ctx.projectId, chapter, result.value)
    }
  })
}

/**
 * Interleaved per-chapter loop: plan chapter N (seeing real summaries/ledger of
 * chapters < N) → write final prose → summarize and update the ledger.
 */
export async function runChapterLoop(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const count = project.chapter_count
  if (!count) throw new Error('Chapter count missing — bible stage incomplete')
  const { plannerModel, drafterModel } = getAppSettings()
  const llm = getLlm()
  const outline = OutlineSchema.parse(
    JSON.parse(getCurrentContent(ctx.projectId, 'outline') ?? '{}')
  )

  for (let ch = 1; ch <= count; ch++) {
    const prefix = storyPrefix(project)
    const outlineRow = outline.chapters.find((c) => c.index === ch)
    if (!outlineRow) throw new Error(`Outline has no chapter ${ch}`)
    const summaries = priorSummaries(ctx.projectId, ch)
    // Only entries from chapters < ch: identical whether computed live or on
    // resume after later chapters were written — keeps the step hash stable.
    const ledgerText = renderLedger(readLedger(ctx.projectId).filter((e) => e.chapter < ch))
    const prevPlan = ch > 1 ? getCurrentContent(ctx.projectId, 'chapter_plan', ch - 1) : null

    emitProgress(ctx.projectId, chKey(ch, 'plan'), `Plotting chapter ${ch} of ${count}`, ch, count)
    await runStep(
      ctx,
      chKey(ch, 'plan'),
      stepHash(
        PROMPT_VERSION,
        plannerModel,
        ch,
        JSON.stringify(outlineRow),
        summaries,
        ledgerText,
        prevPlan
      ),
      async (rec) => {
        const result = await llm.structured({
          model: plannerModel,
          system: prefix,
          messages: [
            {
              role: 'user',
              content: chapterPlanUser({
                chapter: ch,
                outlineRow,
                priorSummaries: summaries,
                ledger: ledgerText,
                prevPlanJson: prevPlan
              })
            }
          ],
          maxTokens: 16000,
          effort: 'high',
          schemaName: 'chapterPlan',
          schema: ChapterPlanSchema,
          onUsage: rec,
          signal: ctx.signal
        })
        return {
          artifact: {
            kind: 'chapter_plan',
            chapter: ch,
            content: JSON.stringify(result.value, null, 2)
          },
        }
      }
    )

    const planJson = getCurrentContent(ctx.projectId, 'chapter_plan', ch) ?? ''
    const prevTail = previousTail(ctx.projectId, ch)

    emitProgress(ctx.projectId, chKey(ch, 'prose'), `Writing chapter ${ch} of ${count}`, ch, count)
    await runStep(
      ctx,
      chKey(ch, 'prose'),
      stepHash(PROMPT_VERSION, drafterModel, ch, planJson, summaries, ledgerText, prevTail),
      async (rec, onToken) => {
        const userMsg = chapterProseUser({
          chapter: ch,
          targetWords: outlineRow.targetWords,
          planJson,
          priorSummaries: summaries,
          ledger: ledgerText,
          prevTail
        })
        let result = await llm.prose({
          model: drafterModel,
          system: prefix,
          messages: [{ role: 'user', content: userMsg }],
          maxTokens: 24000,
          effort: 'high',
          onToken,
          onUsage: rec,
          signal: ctx.signal
        })

        // Length discipline: one corrective retry when outside ±20%.
        const words = countWords(result.text)
        const lo = outlineRow.targetWords * 0.8
        const hi = outlineRow.targetWords * 1.2
        if (words < lo || words > hi) {
          const retry = await llm.prose({
            model: drafterModel,
            system: prefix,
            messages: [
              { role: 'user', content: userMsg },
              { role: 'assistant', content: result.text },
              {
                role: 'user',
                content: `Your draft is ${words} words; the target is approximately ${outlineRow.targetWords} words (±20%). Rewrite the full chapter to that length, preserving content, disclosure discipline and voice. Output only the chapter text.`
              }
            ],
            maxTokens: 24000,
            effort: 'high',
            onUsage: rec,
            signal: ctx.signal
          })
          const retryWords = countWords(retry.text)
          // Keep whichever landed closer to target
          if (
            Math.abs(retryWords - outlineRow.targetWords) <
            Math.abs(words - outlineRow.targetWords)
          ) {
            result = retry
          }
        }

        return {
          artifact: { kind: 'chapter_final', chapter: ch, content: result.text },
        }
      }
    )

    emitProgress(
      ctx.projectId,
      chKey(ch, 'summary'),
      `Recording continuity for chapter ${ch} of ${count}`,
      ch,
      count
    )
    const proseText = getCurrentContent(ctx.projectId, 'chapter_final', ch) ?? ''
    await runSummaryStep(
      ctx,
      chKey(ch, 'summary'),
      stepHash(PROMPT_VERSION, drafterModel, ch, proseText),
      ch
    )
  }
}
