import type { AppSettings, TextProvider } from '@shared/domain'
import { DEFAULT_MODELS } from '@shared/domain'
import { getSetting, setSetting } from '../db/repo/settingsRepo'

const KEY_ANTHROPIC = 'anthropic_key_enc'
const KEY_OPENAI = 'openai_key_enc'
const KEY_PLANNER = 'planner_model'
const KEY_DRAFTER = 'drafter_model'
const KEY_AUTHOR = 'author_name'
const KEY_PROVIDER = 'text_provider'
const DEFAULT_AUTHOR = 'Damien Knox'

/**
 * Electron-free module: main/index.ts injects a safeStorage-backed cipher at
 * boot. Headless tests never register one (mock mode needs no keys).
 */
export interface KeyCipher {
  encrypt(plain: string): string
  decrypt(encoded: string): string
}

let cipher: KeyCipher | null = null

export function setKeyCipher(c: KeyCipher): void {
  cipher = c
}

function encrypt(plain: string): string {
  if (!cipher) throw new Error('OS-level encryption unavailable; cannot store API keys safely')
  return cipher.encrypt(plain)
}

function decrypt(encoded: string | null): string | null {
  if (!encoded || !cipher) return null
  return cipher.decrypt(encoded)
}

export function getAppSettings(): AppSettings {
  return {
    anthropicKeySet: !!getSetting(KEY_ANTHROPIC),
    openaiKeySet: !!getSetting(KEY_OPENAI),
    plannerModel: getSetting(KEY_PLANNER) ?? DEFAULT_MODELS.plannerModel,
    drafterModel: getSetting(KEY_DRAFTER) ?? DEFAULT_MODELS.drafterModel,
    authorName: getSetting(KEY_AUTHOR) ?? DEFAULT_AUTHOR,
    textProvider: (getSetting(KEY_PROVIDER) as TextProvider | null) ?? 'api'
  }
}

export function updateSettings(patch: {
  anthropicKey?: string
  openaiKey?: string
  plannerModel?: string
  drafterModel?: string
  authorName?: string
  textProvider?: TextProvider
}): AppSettings {
  if (patch.anthropicKey !== undefined) {
    setSetting(KEY_ANTHROPIC, patch.anthropicKey ? encrypt(patch.anthropicKey) : null)
  }
  if (patch.openaiKey !== undefined) {
    setSetting(KEY_OPENAI, patch.openaiKey ? encrypt(patch.openaiKey) : null)
  }
  if (patch.plannerModel !== undefined) setSetting(KEY_PLANNER, patch.plannerModel)
  if (patch.drafterModel !== undefined) setSetting(KEY_DRAFTER, patch.drafterModel)
  if (patch.authorName !== undefined) setSetting(KEY_AUTHOR, patch.authorName)
  if (patch.textProvider !== undefined) setSetting(KEY_PROVIDER, patch.textProvider)
  return getAppSettings()
}

export function getAnthropicKey(): string | null {
  return decrypt(getSetting(KEY_ANTHROPIC))
}

export function getOpenaiKey(): string | null {
  return decrypt(getSetting(KEY_OPENAI))
}
