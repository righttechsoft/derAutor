import { ClarifyTurnSchema } from '@shared/schemas/clarify'
import { addClarifyMessage, currentClarifyRound, getClarifyHistory } from '../../db/repo/clarify'
import { getProjectRow } from '../../db/repo/projects'
import { recordLlmCall } from '../../db/repo/usage'
import { getLlm } from '../../llm/provider'
import { log, logError } from '../../services/logger'
import { getAppSettings } from '../../services/settings'
import { sendEvent } from '../../ipc/events'
import { clarifyPrefix, seedPrefix } from '../contextPack'
import { clarifySequelSystem, clarifySystem } from '../prompts'
import { readWorldSeed } from '../worldSeed'
import { emitCost } from '../engine'

/**
 * The interactive world-clarification interview. Not a background job: each
 * assistant turn is one LLM call driven by IPC, persisted in clarify_messages.
 */

const busy = new Set<string>()

async function respond(projectId: string): Promise<void> {
  if (busy.has(projectId)) {
    // Never drop a turn silently — tell the user what's happening.
    sendEvent('clarify:error', {
      projectId,
      message: 'The interviewer is still working on the previous reply — give it a moment, then send again.'
    })
    return
  }
  busy.add(projectId)
  try {
    const project = getProjectRow(projectId)
    const seed = readWorldSeed(projectId)
    const history = getClarifyHistory(projectId)
    const messages = history.map((m) => ({ role: m.role, content: m.content }))
    if (messages.length === 0 || messages[0].role !== 'user') {
      messages.unshift({
        role: 'user',
        content: seed
          ? 'Begin the interview: ask your first clarifying questions about my new story in this world.'
          : 'Begin the interview: ask your first clarifying questions about my world and premise.'
      })
    }

    const { plannerModel } = getAppSettings()
    log(
      'clarify',
      `turn start project=${projectId} model=${plannerModel} historyMessages=${messages.length}`
    )
    const system = seed
      ? [
          ...seedPrefix(project, seed),
          {
            text: clarifySequelSystem({
              language: project.language,
              genreHint: project.genre_hint,
              targetWords: project.target_words,
              sourceBookTitle: seed.sourceBookTitle,
              whatsNew: project.world_input,
              premiseInput: project.premise_input
            })
          }
        ]
      : [
          ...clarifyPrefix(project),
          {
            text: clarifySystem({
              language: project.language,
              genreHint: project.genre_hint,
              targetWords: project.target_words,
              worldInput: project.world_input,
              premiseInput: project.premise_input
            })
          }
        ]

    const result = await getLlm().structured({
      model: plannerModel,
      system,
      messages,
      maxTokens: 12000,
      // Interview turns are conversational probing, not deep plotting — medium
      // effort answers in seconds-to-a-minute instead of many minutes.
      effort: 'medium',
      schemaName: 'clarifyTurn',
      schema: ClarifyTurnSchema,
      // Interactive chat: fail fast. Note the HTTP timeout is per attempt and
      // timeouts are retried, so keep the retry count at 1.
      timeoutMs: 5 * 60 * 1000,
      maxRetries: 1
    })

    recordLlmCall({
      projectId,
      jobId: null,
      provider: result.usage.provider,
      model: result.usage.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costUsd: result.usage.costUsd,
      durationMs: result.usage.durationMs,
      stopReason: result.usage.stopReason
    })
    emitCost(projectId)

    // Belt and braces: strip HTML line breaks / stray tags if the model still
    // emits them despite the schema contract.
    const cleanText = result.value.message
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|span|em|strong|i|b)>/gi, '')
      .trim()

    const round = currentClarifyRound(projectId)
    const message = addClarifyMessage(projectId, 'assistant', cleanText, round)
    log(
      'clarify',
      `turn ok project=${projectId} ready=${result.value.ready} replyChars=${cleanText.length} ms=${result.usage.durationMs}`
    )
    sendEvent('clarify:message', { projectId, message, ready: result.value.ready })
  } finally {
    busy.delete(projectId)
  }
}

function emitClarifyError(projectId: string, err: unknown): void {
  logError('clarify', `turn failed project=${projectId}`, err)
  sendEvent('clarify:error', {
    projectId,
    message: err instanceof Error ? err.message : String(err)
  })
}

/** Fired after project creation: the AI opens the interview. */
export function kickoffClarify(projectId: string): void {
  void respond(projectId).catch((err) => emitClarifyError(projectId, err))
}

export async function clarifyUserMessage(projectId: string, text: string): Promise<void> {
  const round = currentClarifyRound(projectId) + 1
  addClarifyMessage(projectId, 'user', text, round)
  try {
    await respond(projectId)
  } catch (err) {
    emitClarifyError(projectId, err)
    throw err
  }
}
