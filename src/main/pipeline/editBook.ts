import type { EditChatRequest, EditChatResult, EditOp, EditReport } from '@shared/editOps'
import { applyEditOps } from '@shared/editOps'
import { EditOpsOutputSchema } from '@shared/schemas/editOps'
import { inTransaction } from '../db/database'
import { getArtifactVersions, getChapterArtifacts, getCurrentContent, saveArtifact } from '../db/repo/artifacts'
import { getProjectRow } from '../db/repo/projects'
import { recordLlmCall } from '../db/repo/usage'
import { getLlm } from '../llm/provider'
import type { LlmUsage } from '../llm/types'
import { getAppSettings } from '../services/settings'
import { sendEvent } from '../ipc/events'
import { logError } from '../services/logger'
import { emitCost } from './engine'
import { storyPrefix } from './contextPack'
import { editChatReplyUser, editOpsUser } from './prompts'

/**
 * Interactive editor for finished edit variants: a streaming chat that PATCHES
 * chapter prose via anchored find/replace ops (never full rewrites). Runs OUT
 * of the engine — synchronous, cheap, user-driven, like guidedRefine — so it
 * writes no jobs rows and cannot regress the kill-and-resume invariant.
 */

const editing = new Set<string>()

function scopeLabel(req: EditChatRequest): string {
  if (req.selection) return `chapter ${req.selection.chapter} (a selected passage)`
  if (req.chapter != null) return `chapter ${req.chapter}`
  return 'the whole book'
}

function chaptersInScope(projectId: string, chapter?: number): { chapter: number; content: string }[] {
  if (chapter != null) {
    const content = getCurrentContent(projectId, 'chapter_final', chapter)
    return content != null ? [{ chapter, content }] : []
  }
  return getChapterArtifacts(projectId, 'chapter_final')
    .filter((a) => a.chapter != null)
    .map((a) => ({ chapter: a.chapter as number, content: a.content }))
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

/**
 * One interactive edit turn: streams a conversational reply describing the
 * change, gets anchored find/replace ops for it, and applies them.
 */
export async function editChat(projectId: string, req: EditChatRequest): Promise<EditChatResult> {
  if (editing.has(projectId)) {
    sendEvent('edit:error', { projectId, message: 'Still working on the previous request — give it a moment.' })
    return { reply: '', report: { applied: 0, notFound: 0, ambiguous: 0, results: [] } }
  }
  const project = getProjectRow(projectId)
  if (project.edit_copy !== 1) throw new Error('Not an edit variant — edits can never target a finished book directly')

  editing.add(projectId)
  try {
    const { plannerModel } = getAppSettings()
    const llm = getLlm()
    const system = storyPrefix(project)
    const scope = scopeLabel(req)

    const replyResult = await llm.prose({
      model: plannerModel,
      system,
      messages: [{ role: 'user', content: editChatReplyUser({ message: req.message, scope }) }],
      maxTokens: 2000,
      effort: 'low',
      onToken: (delta) => sendEvent('edit:token', { projectId, delta })
    })
    recordUsage(projectId, 'edit:chat:reply', replyResult.usage)

    let ops: EditOp[]
    if (req.selection) {
      // ponytail: the selection's span is already an unambiguous anchor (the renderer
      // copies it verbatim from the current chapter text), so we don't trust the model
      // for `find` — we only ask it for the replacement via the same structured editOps
      // call, scoped to just that span, and splice the known span ourselves.
      const spanResult = await llm.structured({
        model: plannerModel,
        system,
        messages: [
          {
            role: 'user',
            content: editOpsUser({
              instruction: req.selection.instruction,
              chapters: [{ chapter: req.selection.chapter, content: req.selection.text }]
            })
          }
        ],
        maxTokens: 4000,
        effort: 'high',
        schemaName: 'editOps',
        schema: EditOpsOutputSchema
      })
      recordUsage(projectId, 'edit:chat:ops', spanResult.usage)
      const replace = spanResult.value.ops[0]?.replace ?? req.selection.text
      ops = [
        {
          chapter: req.selection.chapter,
          find: req.selection.text,
          replace,
          reason: spanResult.value.ops[0]?.reason
        }
      ]
    } else {
      const chapters = chaptersInScope(projectId, req.chapter)
      const opsResult = await llm.structured({
        model: plannerModel,
        system,
        messages: [{ role: 'user', content: editOpsUser({ instruction: req.message, chapters }) }],
        maxTokens: 16000,
        effort: 'high',
        schemaName: 'editOps',
        schema: EditOpsOutputSchema
      })
      recordUsage(projectId, 'edit:chat:ops', opsResult.usage)
      ops = opsResult.value.ops
    }

    const report = applyOps(projectId, ops)
    emitCost(projectId)
    return { reply: replyResult.text, report }
  } finally {
    editing.delete(projectId)
  }
}

/** Groups ops by chapter and applies them against the current chapter_final text. */
export function applyOps(projectId: string, ops: EditOp[]): EditReport {
  const byChapter = new Map<number, EditOp[]>()
  for (const op of ops) {
    const list = byChapter.get(op.chapter) ?? []
    list.push(op)
    byChapter.set(op.chapter, list)
  }

  const report: EditReport = { applied: 0, notFound: 0, ambiguous: 0, results: [] }
  inTransaction(() => {
    for (const [chapter, chapterOps] of byChapter) {
      const current = getCurrentContent(projectId, 'chapter_final', chapter)
      if (current == null) {
        for (const op of chapterOps) {
          report.notFound++
          report.results.push({ chapter, find: op.find, status: 'not-found' })
        }
        continue
      }
      const { text, results } = applyEditOps(current, chapterOps)
      for (const r of results) {
        report.results.push({ chapter, find: r.op.find, status: r.status })
        if (r.status === 'applied') report.applied++
        else if (r.status === 'not-found') report.notFound++
        else report.ambiguous++
      }
      if (text !== current) saveArtifact(projectId, 'chapter_final', chapter, text)
    }
  })
  return report
}

/** No LLM: replaces every exact occurrence of `from` with `to` across all chapters. */
export function applyRename(projectId: string, from: string, to: string): EditReport {
  const report: EditReport = { applied: 0, notFound: 0, ambiguous: 0, results: [] }
  inTransaction(() => {
    for (const a of getChapterArtifacts(projectId, 'chapter_final')) {
      if (a.chapter == null) continue
      if (!a.content.includes(from)) {
        report.notFound++
        report.results.push({ chapter: a.chapter, find: from, status: 'not-found' })
        continue
      }
      const next = a.content.split(from).join(to)
      saveArtifact(projectId, 'chapter_final', a.chapter, next)
      report.applied++
      report.results.push({ chapter: a.chapter, find: from, status: 'applied' })
    }
  })
  return report
}

/** Append-only undo: re-saves the second-to-last version's content as a new current version. */
export function undoEdit(projectId: string, chapter: number): void {
  const versions = getArtifactVersions(projectId, 'chapter_final', chapter)
  if (versions.length < 2) return
  const previous = versions[versions.length - 2]
  inTransaction(() => {
    saveArtifact(projectId, 'chapter_final', chapter, previous.content)
  })
}

export function editChatSafe(projectId: string, req: EditChatRequest): Promise<EditChatResult | null> {
  return editChat(projectId, req).catch((err) => {
    logError('edit', `chat failed project=${projectId}`, err)
    sendEvent('edit:error', {
      projectId,
      message: err instanceof Error ? err.message : String(err)
    })
    return null
  })
}
