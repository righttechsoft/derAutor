import type { LlmProvider } from './types'
import { anthropicProvider } from './anthropic'
import { claudeCodeProvider } from './claudeCode'
import { mockProvider } from './mock'
import { getAppSettings } from '../services/settings'

export function isMockMode(): boolean {
  return process.env.MOCK_LLM === '1'
}

export function getLlm(): LlmProvider {
  if (isMockMode()) return mockProvider
  return getAppSettings().textProvider === 'claude-code' ? claudeCodeProvider : anthropicProvider
}
