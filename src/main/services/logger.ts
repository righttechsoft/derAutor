import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Dead-simple file logger for the main process. One line per event,
 * derautor.log in <userData>/logs, rotated at ~5MB to derautor.log.old.
 * Also echoed to stderr (visible in `npm run dev`).
 */

let logDir: string | null = null

export function initLogger(dir: string): void {
  logDir = dir
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    logDir = null
  }
  log('logger', `log file: ${dir ? join(dir, 'derautor.log') : '(unavailable)'}`)
}

function serialize(extra: unknown): string {
  try {
    return typeof extra === 'string' ? extra : JSON.stringify(extra)
  } catch {
    return String(extra)
  }
}

export function log(scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}${
    extra !== undefined ? ' ' + serialize(extra) : ''
  }`
  console.error(line)
  if (!logDir) return
  try {
    const file = join(logDir, 'derautor.log')
    try {
      if (statSync(file).size > 5_000_000) {
        rmSync(file + '.old', { force: true })
        renameSync(file, file + '.old')
      }
    } catch {
      // file doesn't exist yet
    }
    appendFileSync(file, line + '\n')
  } catch {
    // never let logging break the app
  }
}

/** Logs an error with the interesting SDK fields (status, API error type) and a short stack. */
export function logError(scope: string, context: string, err: unknown): void {
  const e = err as {
    message?: string
    name?: string
    status?: number
    type?: string
    error?: { type?: string; error?: { type?: string; message?: string } }
    stack?: string
  }
  log(scope, `ERROR ${context}`, {
    message: e?.message,
    name: e?.name,
    status: e?.status,
    apiErrorType: e?.error?.error?.type ?? e?.error?.type ?? e?.type,
    stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 4).join(' <- ') : undefined
  })
}
