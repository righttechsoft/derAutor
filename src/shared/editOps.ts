export interface EditOp {
  chapter: number
  find: string // exact substring to locate (anchor)
  replace: string // text to put in its place
  reason?: string
}

export type OpStatus = 'applied' | 'not-found' | 'ambiguous'

export interface OpResult {
  op: EditOp
  status: OpStatus
}

/** Counts non-overlapping occurrences of `find` in `text`. */
function countOccurrences(text: string, find: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(find, from)
    if (at === -1) break
    count++
    from = at + find.length
  }
  return count
}

/**
 * Applies anchored find/replace ops in order, each against the current
 * (already-mutated) text. `find` is a literal substring, not a regex.
 * An op only applies when its `find` is unambiguous (exactly one
 * non-overlapping occurrence) in the text at the time it runs.
 */
export function applyEditOps(text: string, ops: EditOp[]): { text: string; results: OpResult[] } {
  let current = text
  const results: OpResult[] = []

  for (const op of ops) {
    if (op.find === '') {
      results.push({ op, status: 'not-found' })
      continue
    }

    const occurrences = countOccurrences(current, op.find)
    if (occurrences === 0) {
      results.push({ op, status: 'not-found' })
      continue
    }
    if (occurrences > 1) {
      results.push({ op, status: 'ambiguous' })
      continue
    }

    const at = current.indexOf(op.find)
    current = current.slice(0, at) + op.replace + current.slice(at + op.find.length)
    results.push({ op, status: 'applied' })
  }

  return { text: current, results }
}

/** Outcome of applying a batch of ops (possibly across several chapters). */
export interface EditReport {
  applied: number
  notFound: number
  ambiguous: number
  results: { chapter: number; find: string; status: OpStatus }[]
}

/** One turn of the interactive edit chat: a free-text instruction, optionally scoped. */
export interface EditChatRequest {
  message: string
  /** Restrict the edit to one chapter (no selection popup). */
  chapter?: number
  /** From the selection popup: the verbatim selected span and what to do with it. */
  selection?: { chapter: number; text: string; instruction: string }
}

export interface EditChatResult {
  reply: string
  report: EditReport
}
