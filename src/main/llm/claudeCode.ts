import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { log, logError } from '../services/logger'
import type {
  ChatMessage,
  LlmProvider,
  LlmUsage,
  ProseRequest,
  ProseResult,
  StructuredRequest,
  StructuredResult,
  SystemBlock
} from './types'

/**
 * Text generation through the local Claude Code runtime (Agent SDK) — billed
 * against the user's Claude subscription instead of per-token API pricing.
 * Same LlmProvider contract as the API provider; prompt caching and token
 * accounting are managed by Claude Code itself (cost reports ~$0 on plans).
 */

function systemText(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n')
}

/** Our calls are single-turn except clarify — render history into one prompt. */
function renderPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0].content
  return messages
    .map((m) => (m.role === 'user' ? `AUTHOR:\n${m.content}` : `YOUR PREVIOUS REPLY:\n${m.content}`))
    .join('\n\n---\n\n')
}

interface RunResult {
  text: string
  structured: unknown
  usage: LlmUsage
}

async function runQuery(req: {
  model: string
  system: SystemBlock[]
  messages: ChatMessage[]
  effort?: string
  signal?: AbortSignal
  schema?: z.ZodType
  label: string
}): Promise<RunResult> {
  const started = Date.now()
  const abort = new AbortController()
  if (req.signal) {
    if (req.signal.aborted) abort.abort()
    else req.signal.addEventListener('abort', () => abort.abort(), { once: true })
  }

  log('claude-code', `start ${req.label} model=${req.model}`)
  const q = query({
    prompt: renderPrompt(req.messages),
    options: {
      model: req.model,
      systemPrompt: systemText(req.system),
      maxTurns: 1,
      allowedTools: [],
      settingSources: [], // never load CLAUDE.md or user settings into book prompts
      abortController: abort,
      ...(req.effort ? { effort: req.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      ...(req.schema
        ? { outputFormat: { type: 'json_schema' as const, schema: z.toJSONSchema(req.schema) } }
        : {})
    }
  })

  let text = ''
  let structured: unknown
  let usage: LlmUsage | null = null
  for await (const message of q) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text
      }
    } else if (message.type === 'result') {
      const u = message.usage
      usage = {
        provider: 'claude-code',
        model: req.model,
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
        costUsd: message.total_cost_usd ?? 0,
        durationMs: Date.now() - started,
        stopReason: 'stop_reason' in message ? message.stop_reason : null
      }
      if (message.subtype !== 'success') {
        const detail =
          'result' in message && typeof (message as { result?: unknown }).result === 'string'
            ? `: ${(message as { result: string }).result}`
            : ''
        logError('claude-code', `${req.label} ${message.subtype}`, new Error(detail))
        throw new Error(`Claude Code ${message.subtype}${detail}`.slice(0, 400))
      }
      if (message.result) text = message.result
      structured = message.structured_output
    }
  }
  if (!usage) throw new Error('Claude Code query produced no result message')
  log(
    'claude-code',
    `done ${req.label} in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} ms=${usage.durationMs}`
  )
  return { text, structured, usage }
}

async function prose(req: ProseRequest): Promise<ProseResult> {
  const { text, usage } = await runQuery({
    model: req.model,
    system: req.system,
    messages: req.messages,
    effort: req.effort,
    signal: req.signal,
    label: 'prose'
  })
  req.onUsage?.(usage)
  if (!text.trim()) throw new Error('Claude Code returned empty prose')
  return { text, usage }
}

async function structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, structured: obj, usage } = await runQuery({
      model: req.model,
      system: req.system,
      messages: req.messages,
      effort: req.effort,
      signal: req.signal,
      schema: req.schema,
      label: `structured ${req.schemaName} attempt=${attempt}`
    })
    req.onUsage?.(usage)
    try {
      if (obj !== undefined && obj !== null) {
        return { value: req.schema.parse(obj), usage }
      }
      // Fallback: some paths return the JSON only as text
      const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
      return { value: req.schema.parse(JSON.parse(cleaned)), usage }
    } catch (err) {
      logError('claude-code', `structured ${req.schemaName} validation attempt=${attempt}`, err)
      lastError = new Error(
        `Claude Code structured output for ${req.schemaName} failed validation: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`
      )
    }
  }
  throw lastError
}

export const claudeCodeProvider: LlmProvider = { prose, structured }
