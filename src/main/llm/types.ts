import type { ZodType } from 'zod'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LlmUsage {
  provider: 'anthropic' | 'claude-code' | 'openai' | 'mock'
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  durationMs: number
  stopReason: string | null
}

/** One system block; `cache: true` marks the prompt-cache breakpoint (byte-stable prefix ends here). */
export interface SystemBlock {
  text: string
  cache?: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ProseRequest {
  model: string
  system: SystemBlock[]
  messages: ChatMessage[]
  maxTokens: number
  effort?: Effort
  onToken?: (delta: string) => void
  /**
   * Invoked once per PHYSICAL api call (including internal retries), the moment
   * its usage is known — so spend is recorded even when the step later fails.
   */
  onUsage?: (usage: LlmUsage) => void
  signal?: AbortSignal
}

export interface StructuredRequest<T> {
  model: string
  system: SystemBlock[]
  messages: ChatMessage[]
  maxTokens: number
  effort?: Effort
  /** Stable key identifying the output shape — the mock provider dispatches on it. */
  schemaName: string
  schema: ZodType<T>
  /** See ProseRequest.onUsage. */
  onUsage?: (usage: LlmUsage) => void
  /** Per-request HTTP timeout override (interactive calls want minutes, not the pipeline's 30). */
  timeoutMs?: number
  /** Per-request retry override — interactive calls want fast failure, not 4 silent retries. */
  maxRetries?: number
  signal?: AbortSignal
}

export interface ProseResult {
  text: string
  usage: LlmUsage
}

export interface StructuredResult<T> {
  value: T
  usage: LlmUsage
}

export interface LlmProvider {
  prose(req: ProseRequest): Promise<ProseResult>
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>
}
