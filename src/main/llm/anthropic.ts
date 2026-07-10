import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { log, logError } from '../services/logger'
import { getAnthropicKey } from '../services/settings'
import { computeCostUsd } from './pricing'
import type {
  LlmProvider,
  LlmUsage,
  ProseRequest,
  ProseResult,
  StructuredRequest,
  StructuredResult,
  SystemBlock
} from './types'

function getClient(): Anthropic {
  const apiKey = getAnthropicKey()
  if (!apiKey) throw new Error('Anthropic API key is not configured (Settings)')
  // Whole-book review calls read ~200k tokens; give plenty of headroom.
  return new Anthropic({ apiKey, maxRetries: 4, timeout: 30 * 60 * 1000 })
}

/**
 * Claude 4.6+ / 5 family rules:
 * - Opus 4.6/4.7/4.8, Sonnet 5, Sonnet 4.6: thinking must be explicitly adaptive.
 * - Fable 5: thinking is always on — the parameter must be omitted entirely.
 * - Pre-4.6 Opus (4-0/4-1/4-5), Haiku, older: no adaptive thinking (would 400).
 * - temperature/top_p/top_k are rejected on the 4.6+/5 family — never sent.
 */
const ADAPTIVE_MODELS = ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6']

function thinkingFor(model: string): { type: 'adaptive' } | undefined {
  if (ADAPTIVE_MODELS.some((m) => model.startsWith(m))) return { type: 'adaptive' }
  return undefined
}

function supportsEffort(model: string): boolean {
  return model.startsWith('claude-fable') || ADAPTIVE_MODELS.some((m) => model.startsWith(m))
}

function toSystem(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  return blocks.map((b) => ({
    type: 'text' as const,
    text: b.text,
    // 1h TTL: same-model pipeline calls are typically 5-15 minutes apart, which
    // always misses the default 5-minute cache (observed cacheRead=0 in the wild).
    ...(b.cache ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } } : {})
  }))
}

function toUsage(
  model: string,
  usage: Anthropic.Usage,
  durationMs: number,
  stopReason: string | null
): LlmUsage {
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  return {
    provider: 'anthropic',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: computeCostUsd(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    durationMs,
    stopReason
  }
}

const PROSE_MAX_TOKENS_CAP = 64_000

async function prose(req: ProseRequest): Promise<ProseResult> {
  const client = getClient()
  const thinking = thinkingFor(req.model)

  // One automatic retry with a doubled budget when output truncates at max_tokens
  // (adaptive thinking shares the budget) — truncated prose must never be saved.
  let maxTokens = req.maxTokens
  for (let attempt = 0; ; attempt++) {
    const started = Date.now()
    log('llm', `prose start model=${req.model} maxTokens=${maxTokens} attempt=${attempt}`)
    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: maxTokens,
        system: toSystem(req.system),
        messages: req.messages,
        ...(thinking ? { thinking } : {}),
        ...(req.effort && supportsEffort(req.model)
          ? { output_config: { effort: req.effort } }
          : {})
      },
      { signal: req.signal }
    )
    if (req.onToken) stream.on('text', req.onToken)
    let msg: Anthropic.Message
    try {
      msg = await stream.finalMessage()
    } catch (err) {
      logError('llm', `prose model=${req.model} attempt=${attempt}`, err)
      throw err
    }
    const usage = toUsage(req.model, msg.usage, Date.now() - started, msg.stop_reason)
    req.onUsage?.(usage)
    log(
      'llm',
      `prose done model=${req.model} stop=${msg.stop_reason} in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} ms=${usage.durationMs}`
    )
    if (msg.stop_reason === 'refusal') {
      throw new Error(`Model ${req.model} refused the request`)
    }
    if (msg.stop_reason === 'max_tokens') {
      if (attempt === 0 && maxTokens < PROSE_MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, PROSE_MAX_TOKENS_CAP)
        continue
      }
      throw new Error(`Prose output truncated at max_tokens=${maxTokens}`)
    }
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return { text, usage }
  }
}

async function structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const client = getClient()
  const thinking = thinkingFor(req.model)

  // RAW streaming (client.messages.create with stream:true), not the
  // MessageStream helper: with output_config.format set, the helper re-parses
  // the JSON inside finalMessage() and throws away entire expensive responses
  // over a truncation or a single off-schema field. We accumulate the text and
  // do all parsing/validation ourselves.
  //
  // Adaptive thinking shares the max_tokens budget with the JSON output, so a
  // truncated response retries with a doubled budget — same discipline as prose().
  const STRUCTURED_MAX_TOKENS_CAP = 64_000
  let maxTokens = req.maxTokens
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = Date.now()
    log(
      'llm',
      `structured start ${req.schemaName} model=${req.model} maxTokens=${maxTokens} attempt=${attempt}`
    )

    let text = ''
    let stopReason: string | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    try {
      const stream = await client.messages.create(
        {
          model: req.model,
          max_tokens: maxTokens,
          system: toSystem(req.system),
          messages: req.messages,
          stream: true,
          ...(thinking ? { thinking } : {}),
          output_config: {
            format: zodOutputFormat(req.schema),
            ...(req.effort && supportsEffort(req.model) ? { effort: req.effort } : {})
          }
        },
        {
          signal: req.signal,
          ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
          ...(req.maxRetries != null ? { maxRetries: req.maxRetries } : {})
        }
      )
      for await (const event of stream) {
        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens
          cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0
          cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
        } else if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason
          outputTokens = event.usage.output_tokens
        }
      }
    } catch (err) {
      logError('llm', `structured ${req.schemaName} model=${req.model} attempt=${attempt}`, err)
      throw err
    }

    const usage: LlmUsage = {
      provider: 'anthropic',
      model: req.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: computeCostUsd(req.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
      durationMs: Date.now() - started,
      stopReason
    }
    req.onUsage?.(usage)
    log(
      'llm',
      `structured done ${req.schemaName} stop=${stopReason} in=${inputTokens} out=${outputTokens} cacheRead=${cacheReadTokens} ms=${usage.durationMs}`
    )

    if (stopReason === 'refusal') {
      throw new Error(`Model ${req.model} refused the request`)
    }
    if (stopReason === 'max_tokens') {
      lastError = new Error(
        `Structured output truncated at max_tokens=${maxTokens} (${req.schemaName})`
      )
      if (maxTokens < STRUCTURED_MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, STRUCTURED_MAX_TOKENS_CAP)
        continue
      }
      throw lastError
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Malformed despite end_turn — treat like truncation: more room + reroll.
      lastError = new Error(`Structured output for ${req.schemaName} is not valid JSON`)
      if (maxTokens < STRUCTURED_MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, STRUCTURED_MAX_TOKENS_CAP)
      }
      continue
    }
    try {
      return { value: req.schema.parse(parsed), usage }
    } catch (err) {
      logError('llm', `structured ${req.schemaName} zod validation attempt=${attempt}`, err)
      lastError = new Error(
        `Structured output for ${req.schemaName} failed validation: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`
      )
      // schema violation — reroll with the same budget
    }
  }
  throw lastError
}

export const anthropicProvider: LlmProvider = { prose, structured }
