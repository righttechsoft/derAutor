import { describe, expect, it } from 'vitest'
import { applyEditOps, type EditOp } from '../../src/shared/editOps'

function op(overrides: Partial<EditOp> & Pick<EditOp, 'find' | 'replace'>): EditOp {
  return { chapter: 1, ...overrides }
}

describe('applyEditOps', () => {
  it('applies a single op with an exact splice', () => {
    const { text, results } = applyEditOps('The cat sat on the mat.', [op({ find: 'cat', replace: 'dog' })])
    expect(text).toBe('The dog sat on the mat.')
    expect(results).toEqual([{ op: results[0].op, status: 'applied' }])
  })

  it('reports not-found when the anchor is absent, leaving text unchanged', () => {
    const { text, results } = applyEditOps('The cat sat on the mat.', [op({ find: 'dog', replace: 'cat' })])
    expect(text).toBe('The cat sat on the mat.')
    expect(results[0].status).toBe('not-found')
  })

  it('reports ambiguous when the anchor appears twice and replaces neither', () => {
    const { text, results } = applyEditOps('cat cat', [op({ find: 'cat', replace: 'dog' })])
    expect(text).toBe('cat cat')
    expect(results[0].status).toBe('ambiguous')
  })

  it('lets a later op become unique after an earlier op mutates the text', () => {
    // Before op1, "cat" appears twice (ambiguous). op1 rewrites one, making
    // op2's "cat" unique against the resulting text.
    const ops: EditOp[] = [
      op({ find: 'The cat', replace: 'The dog' }),
      op({ find: 'cat', replace: 'mouse' })
    ]
    const { text, results } = applyEditOps('The cat chased the cat.', ops)
    expect(text).toBe('The dog chased the mouse.')
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied'])
  })

  it('keeps mixed results in order when a later op is not-found', () => {
    const ops: EditOp[] = [
      op({ find: 'cat', replace: 'dog' }),
      op({ find: 'bird', replace: 'fish' })
    ]
    const { text, results } = applyEditOps('The cat sat.', ops)
    expect(text).toBe('The dog sat.')
    expect(results.map((r) => r.status)).toEqual(['applied', 'not-found'])
  })

  it('treats an empty find as not-found rather than matching everywhere', () => {
    const { text, results } = applyEditOps('The cat sat.', [op({ find: '', replace: 'x' })])
    expect(text).toBe('The cat sat.')
    expect(results[0].status).toBe('not-found')
  })

  it('does not re-match when the replacement contains the find substring', () => {
    // op1's replacement ("concatenate") itself contains "cat" once; op2 must
    // re-scan the mutated text from scratch rather than looping on op1's output.
    const ops: EditOp[] = [
      op({ find: 'cat', replace: 'concatenate' }),
      op({ find: 'cat', replace: 'CAT' })
    ]
    const { text, results } = applyEditOps('cat', ops)
    expect(text).toBe('conCATenate')
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied'])
  })

  it('applies multiple distinct ops in order', () => {
    const ops: EditOp[] = [
      op({ find: 'cat', replace: 'dog' }),
      op({ find: 'mat', replace: 'rug' }),
      op({ find: 'sat', replace: 'lay' })
    ]
    const { text, results } = applyEditOps('The cat sat on the mat.', ops)
    expect(text).toBe('The dog lay on the rug.')
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied'])
  })
})
