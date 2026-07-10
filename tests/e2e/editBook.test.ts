import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EditOp } from '@shared/editOps'
import { closeDatabase, getDb, initDatabase } from '../../src/main/db/database'
import { createProject, getProjectRow, listEditVariants, toSummary, updateProject } from '../../src/main/db/repo/projects'
import { getArtifactVersions, getChapterArtifacts, getCurrentContent } from '../../src/main/db/repo/artifacts'
import { listImages } from '../../src/main/db/repo/images'
import { createProjectEditVariant } from '../../src/main/pipeline/editVariants'
import { applyOps, applyRename, undoEdit } from '../../src/main/pipeline/editBook'
import { startProofread } from '../../src/main/pipeline/proofread'
import { startPipeline, pausePipeline, clarifySend } from '../../src/main/pipeline/controller'

process.env.MOCK_LLM = '1'
process.env.DERAUTOR_FAST_RETRY = '1'

function newProjectInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Mock Tides',
    language: 'en',
    targetWords: 4800, // clamps to MIN_CHAPTERS=8 chapters
    illustrations: false,
    genreHint: 'maritime fantasy',
    worldInput: 'A harbor city ruled by tides. Two moons. Spoken-word magic.',
    premiseInput: 'A young tinkerer notices the tide tables have been falsified.',
    ...overrides
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function runToDone(projectId: string): Promise<void> {
  startPipeline(projectId)
  await waitFor(() => {
    const p = getProjectRow(projectId)
    if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
    return p.status === 'done'
  })
}

/** Finishes a fresh mock source book, ready to be cloned into edit variants. */
async function finishedBook(overrides: Record<string, unknown> = {}): Promise<string> {
  const source = createProject(newProjectInput(overrides))
  await clarifySend(source.id, 'The moons are called Vel and Sorrow.')
  await runToDone(source.id)
  return source.id
}

/** A verbatim, deterministically-unique anchor (the chapter's first sentence) plus a patched replacement. */
function firstSentenceOp(projectId: string, chapter: number, tag: string): EditOp {
  const text = getCurrentContent(projectId, 'chapter_final', chapter)!
  const dot = text.indexOf('.')
  const find = dot === -1 ? text : text.slice(0, dot + 1)
  const replace = `${find.replace(/\.$/, '')} (${tag}).`
  return { chapter, find, replace, reason: tag }
}

function callsForStep(projectId: string, stepKey: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ? AND job_id = ?')
      .get(projectId, stepKey) as { n: number }
  ).n
}

function jobStatus(projectId: string, stepKey: string): string | undefined {
  return (
    getDb().prepare('SELECT status FROM jobs WHERE project_id = ? AND step_key = ?').get(projectId, stepKey) as
      | { status: string }
      | undefined
  )?.status
}

describe('edit book e2e', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-editbook-'))
    dbPath = join(dir, 'test.db')
    closeDatabase()
    initDatabase(dbPath)
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.MOCK_LLM_DELAY_MS
  })

  it('clones a finished book into independent, unlocked edit variants', async () => {
    const bookId = await finishedBook({ illustrations: true })
    const sourceFinals = getChapterArtifacts(bookId, 'chapter_final')
    const sourceImages = listImages(bookId)
    expect(sourceImages.length).toBeGreaterThan(0)

    const v1 = createProjectEditVariant(bookId, 'v1')
    const v2 = createProjectEditVariant(bookId, 'v2')

    for (const v of [v1, v2]) {
      expect(v.stage).toBe('done')
      expect(v.authors_room_unlocked).toBe(1)
      expect(v.edit_copy).toBe(1)
      expect(toSummary(v).isTranslation).toBe(false)
      expect(getChapterArtifacts(v.id, 'chapter_final').length).toBe(sourceFinals.length)
      expect(listImages(v.id).length).toBe(sourceImages.length)
      const jobCount = (
        getDb().prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?').get(v.id) as { n: number }
      ).n
      expect(jobCount).toBe(0)
    }
    expect(v1.edit_label).toBe('v1')
    expect(v2.edit_label).toBe('v2')
    expect(v1.edit_label).not.toBe(v2.edit_label)

    const variants = listEditVariants(bookId)
    expect(variants.map((r) => r.id).sort()).toEqual([v1.id, v2.id].sort())
  }, 60_000)

  it('applyOps patches one chapter and bumps its version, leaving the source and sibling variant untouched', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')
    const v2 = createProjectEditVariant(bookId, 'v2')

    const original = getCurrentContent(v1.id, 'chapter_final', 1)!
    const versionsBefore = getArtifactVersions(v1.id, 'chapter_final', 1).length
    const op = firstSentenceOp(v1.id, 1, 'patched')

    const report = applyOps(v1.id, [op])

    expect(report.applied).toBeGreaterThanOrEqual(1)
    const after = getCurrentContent(v1.id, 'chapter_final', 1)
    expect(after).not.toBe(original)
    expect(after).toContain('(patched)')
    expect(getArtifactVersions(v1.id, 'chapter_final', 1).length).toBe(versionsBefore + 1)

    // Cross-project isolation: neither the frozen source nor the sibling variant moved.
    expect(getCurrentContent(bookId, 'chapter_final', 1)).toBe(original)
    expect(getCurrentContent(v2.id, 'chapter_final', 1)).toBe(original)
  }, 60_000)

  it('applyRename replaces every occurrence of a token across all chapters', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')

    const before = getChapterArtifacts(v1.id, 'chapter_final')
    expect(before.every((a) => a.content.includes('Aran'))).toBe(true)
    // Compute the expected post-rename text ourselves rather than hardcoding mock prose.
    const expectedByChapter = new Map(before.map((a) => [a.chapter, a.content.split('Aran').join('Aran-renamed')]))
    const versionsBefore = new Map(before.map((a) => [a.chapter, a.version]))

    const report = applyRename(v1.id, 'Aran', 'Aran-renamed')

    expect(report.applied).toBe(before.length)
    expect(report.notFound).toBe(0)
    for (const a of getChapterArtifacts(v1.id, 'chapter_final')) {
      expect(a.content).toBe(expectedByChapter.get(a.chapter))
      expect(a.version).toBe((versionsBefore.get(a.chapter) ?? 0) + 1)
    }
  }, 60_000)

  it('undoEdit reverts a chapter by appending the pre-edit content as a new version', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')

    const original = getCurrentContent(v1.id, 'chapter_final', 3)!
    const versionsBefore = getArtifactVersions(v1.id, 'chapter_final', 3).length

    applyRename(v1.id, 'Aran', 'Aran-renamed') // touches every chapter, including 3
    expect(getCurrentContent(v1.id, 'chapter_final', 3)).not.toBe(original)
    expect(getArtifactVersions(v1.id, 'chapter_final', 3).length).toBe(versionsBefore + 1)

    undoEdit(v1.id, 3)

    expect(getCurrentContent(v1.id, 'chapter_final', 3)).toBe(original)
    // Append-only: undo added a new version on top rather than deleting the edited one.
    expect(getArtifactVersions(v1.id, 'chapter_final', 3).length).toBe(versionsBefore + 2)
  }, 60_000)

  it('targeted align proofread re-syncs the summary and ledger for the edited chapter only', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')

    const summaryVersionsBefore = getArtifactVersions(v1.id, 'chapter_summary', 4).length
    applyOps(v1.id, [firstSentenceOp(v1.id, 4, 'align test edit')])
    expect(getCurrentContent(v1.id, 'chapter_final', 4)).toContain('(align test edit)')

    startProofread(v1.id, 'align')
    await waitFor(() => {
      const p = getProjectRow(v1.id)
      if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
      return p.status === 'done'
    })

    expect(getProjectRow(v1.id).stage).toBe('done')
    expect(getArtifactVersions(v1.id, 'chapter_summary', 4).length).toBe(summaryVersionsBefore + 1)

    const ledgerRaw = getCurrentContent(v1.id, 'ledger')
    expect(ledgerRaw).toBeTruthy()
    const ledgerEntries = JSON.parse(ledgerRaw!) as { chapter: number }[]
    expect(Array.isArray(ledgerEntries)).toBe(true)
    // align:ledger strips chapter 4's old entries before align:resum re-adds fresh ones
    // (mock's summaryLedger fixture always yields exactly one ledgerUpdate per call), so
    // this also proves there's no stale/duplicate entry left behind for the edited chapter.
    expect(ledgerEntries.filter((e) => e.chapter === 4).length).toBe(1)

    expect(jobStatus(v1.id, 'align:ledger')).toBe('done')
    expect(jobStatus(v1.id, 'align:resum:ch:04')).toBe('done')
    const badJobs = getDb()
      .prepare(`SELECT step_key, status FROM jobs WHERE project_id = ? AND status != 'done'`)
      .all(v1.id)
    expect(badJobs).toEqual([])
  }, 60_000)

  it('align no-ops (creates zero align:* jobs) when nothing was edited', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')

    startProofread(v1.id, 'align')
    await waitFor(() => {
      const p = getProjectRow(v1.id)
      if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
      return p.status === 'done'
    })

    expect(getProjectRow(v1.id).stage).toBe('done')
    const alignJobs = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND step_key LIKE 'align:%'`)
        .get(v1.id) as { n: number }
    ).n
    expect(alignJobs).toBe(0)
  }, 60_000)

  it('full-review proofread resets review_round to 0 and reruns the whole-book review', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')
    applyOps(v1.id, [firstSentenceOp(v1.id, 2, 'review test edit')])

    // Simulate a stale review_round left over from an earlier pass, to prove
    // startProofread('full-review') resets it to 0 rather than resuming from it.
    updateProject(v1.id, { review_round: 2 })

    startProofread(v1.id, 'full-review')
    await waitFor(() => {
      const p = getProjectRow(v1.id)
      if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
      return p.status === 'done'
    })

    expect(getProjectRow(v1.id).stage).toBe('done')
    expect(callsForStep(v1.id, 'review:r1:read')).toBeGreaterThan(0)
    // Mock round 1 always flags 2 issues (fixed), round 2 comes back clean and the loop
    // returns — landing on review_round=2. Had the reset not happened, review_round would
    // have started at 2+1=3 (skipping the round-1 fixture) and landed on 3 instead.
    expect(getProjectRow(v1.id).review_round).toBe(2)
  }, 60_000)

  it('kill-and-resume mid-align makes zero duplicate llm_calls', async () => {
    const bookId = await finishedBook()
    const v1 = createProjectEditVariant(bookId, 'v1')

    // Edit several chapters so the align stage has multiple steps to interrupt across.
    for (const ch of [1, 2, 3]) {
      applyOps(v1.id, [firstSentenceOp(v1.id, ch, 'resume test edit')])
    }

    process.env.MOCK_LLM_DELAY_MS = '25'
    startProofread(v1.id, 'align')
    // Interrupt once the first chapter's continuity has been recomputed but before
    // the whole align pass (ledger reset + 3x resum + 3x conflict check) finishes.
    await waitFor(() => jobStatus(v1.id, 'align:resum:ch:01') === 'done')
    pausePipeline(v1.id)
    await waitFor(() => getProjectRow(v1.id).status === 'paused')

    const doneBefore = getDb()
      .prepare(
        `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
         LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
         WHERE j.project_id = ? AND j.status = 'done' GROUP BY j.step_key`
      )
      .all(v1.id) as { step_key: string; calls: number }[]
    expect(doneBefore.length).toBeGreaterThan(0)
    expect(doneBefore.length).toBeLessThan(7) // ledger + 3x resum + 3x conflict = 7 possible steps

    // Simulate app restart: close and reopen the database file.
    closeDatabase()
    initDatabase(dbPath)
    delete process.env.MOCK_LLM_DELAY_MS

    startPipeline(v1.id) // project.stage is already 'align' after the pause — bare resume
    await waitFor(() => {
      const p = getProjectRow(v1.id)
      if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
      return p.status === 'done'
    })

    const countsAfter = new Map(
      (
        getDb()
          .prepare(
            `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
             LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
             WHERE j.project_id = ? GROUP BY j.step_key`
          )
          .all(v1.id) as { step_key: string; calls: number }[]
      ).map((r) => [r.step_key, r.calls])
    )
    for (const row of doneBefore) {
      expect(countsAfter.get(row.step_key), row.step_key).toBe(row.calls)
    }
    expect(getProjectRow(v1.id).stage).toBe('done')
  }, 120_000)
})
