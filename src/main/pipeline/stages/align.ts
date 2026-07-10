import { ContinuityConflictsSchema } from '@shared/schemas/editOps'
import type { EditOp } from '@shared/editOps'
import { applyEditOps } from '@shared/editOps'
import { getChapterArtifacts, getCurrentContent, saveArtifact } from '../../db/repo/artifacts'
import { getProjectRow } from '../../db/repo/projects'
import { getLlm } from '../../llm/provider'
import { getAppSettings } from '../../services/settings'
import { readLedger, renderLedger, storyPrefix } from '../contextPack'
import { PROMPT_VERSION, continuityAlignUser } from '../prompts'
import type { StepContext } from '../engine'
import { emitProgress, runStep, stepHash } from '../engine'
import { runSummaryStep } from './chapterLoop'

function pad(ch: number): string {
  return String(ch).padStart(2, '0')
}

/** Summaries of every chapter except one, rendered like contextPack's other summary blocks. */
function summariesExcept(projectId: string, excludeChapter: number): string {
  return getChapterArtifacts(projectId, 'chapter_summary')
    .filter((a) => a.chapter !== excludeChapter)
    .map((a) => `Chapter ${a.chapter}:\n${a.content}`)
    .join('\n\n')
}

/**
 * Targeted proofread for an edit variant: recomputes summaries/ledger from the
 * chapters the interactive editor actually touched (chapter_final version > 1)
 * and patches only the continuity discrepancies those edits caused. Never
 * creatively rewrites a chapter the author didn't touch — cross-chapter fixes
 * are anchored find/replace ops only, applied the same way the edit chat does.
 */
export async function runAlignStage(ctx: StepContext): Promise<void> {
  const project = getProjectRow(ctx.projectId)
  const { plannerModel, drafterModel } = getAppSettings()
  const llm = getLlm()

  const editedChapters = getChapterArtifacts(ctx.projectId, 'chapter_final')
    .filter((a) => a.chapter != null && a.version > 1)
    .map((a) => a.chapter as number)
    .sort((a, b) => a - b)

  if (editedChapters.length === 0) return // nothing was edited — nothing to align

  const editedSet = new Set(editedChapters)
  emitProgress(ctx.projectId, 'align:ledger', 'Resetting continuity ledger for edited chapters')
  await runStep(
    ctx,
    'align:ledger',
    stepHash(PROMPT_VERSION, 'align-ledger', editedChapters.join(',')),
    async () => {
      const entries = readLedger(ctx.projectId).filter((e) => !editedSet.has(e.chapter))
      return {
        artifact: { kind: 'ledger', chapter: null, content: JSON.stringify(entries, null, 2) }
      }
    }
  )

  // Re-summarize each edited chapter first — mergeLedger (inside runSummaryStep)
  // re-adds fresh entries only for these chapters, respecting the append-only ledger.
  for (const ch of editedChapters) {
    const resumKey = `align:resum:ch:${pad(ch)}`
    emitProgress(ctx.projectId, resumKey, `Recomputing continuity for chapter ${ch}`, ch, project.chapter_count)
    const proseText = getCurrentContent(ctx.projectId, 'chapter_final', ch) ?? ''
    await runSummaryStep(ctx, resumKey, stepHash(PROMPT_VERSION, drafterModel, ch, proseText), ch)
  }

  // Detect and patch cross-chapter conflicts each edit caused. Tracks which OTHER
  // chapters actually got an applied op, for the bounded re-summarize pass below.
  const maxChapter = project.chapter_count ?? Number.MAX_SAFE_INTEGER
  const patchedOtherChapters = new Set<number>()

  for (const ch of editedChapters) {
    const conflictKey = `align:conflict:ch:${pad(ch)}`
    const editedSummary = getCurrentContent(ctx.projectId, 'chapter_summary', ch) ?? ''
    emitProgress(
      ctx.projectId,
      conflictKey,
      `Checking chapter ${ch}'s edit against the rest of the book`,
      ch,
      project.chapter_count
    )
    await runStep(
      ctx,
      conflictKey,
      stepHash(PROMPT_VERSION, plannerModel, ch, editedSummary),
      async (rec) => {
        const otherSummaries = summariesExcept(ctx.projectId, ch)
        const ledgerText = renderLedger(readLedger(ctx.projectId))
        const result = await llm.structured({
          model: plannerModel,
          system: storyPrefix(project),
          messages: [
            {
              role: 'user',
              content: continuityAlignUser({
                editedChapter: ch,
                editedSummary,
                otherSummaries,
                ledger: ledgerText
              })
            }
          ],
          maxTokens: 8000,
          effort: 'high',
          schemaName: 'continuityConflicts',
          schema: ContinuityConflictsSchema,
          onUsage: rec,
          signal: ctx.signal
        })

        // Anchored ops on OTHER chapters only — never creatively rewrite, and never
        // let a hallucinated chapter number create a phantom chapter_final artifact.
        const byChapter = new Map<number, EditOp[]>()
        for (const op of result.value.conflicts) {
          if (op.chapter === ch) continue
          if (op.chapter < 1 || op.chapter > maxChapter) continue
          const list = byChapter.get(op.chapter) ?? []
          list.push(op)
          byChapter.set(op.chapter, list)
        }
        const writes: { chapter: number; text: string }[] = []
        for (const [otherCh, ops] of byChapter) {
          const current = getCurrentContent(ctx.projectId, 'chapter_final', otherCh)
          if (current == null) continue
          const { text, results } = applyEditOps(current, ops)
          if (results.some((r) => r.status === 'applied')) {
            writes.push({ chapter: otherCh, text })
            patchedOtherChapters.add(otherCh)
          }
        }

        return {
          sideEffect: () => {
            for (const w of writes) saveArtifact(ctx.projectId, 'chapter_final', w.chapter, w.text)
          }
        }
      }
    )
  }

  // Bounded, one pass: re-summarize only the chapters a conflict patch actually touched.
  for (const ch of [...patchedOtherChapters].sort((a, b) => a - b)) {
    const resum2Key = `align:resum2:ch:${pad(ch)}`
    emitProgress(ctx.projectId, resum2Key, `Re-checking continuity for chapter ${ch}`, ch, project.chapter_count)
    const proseText = getCurrentContent(ctx.projectId, 'chapter_final', ch) ?? ''
    await runSummaryStep(ctx, resum2Key, stepHash(PROMPT_VERSION, drafterModel, ch, proseText), ch)
  }
}
