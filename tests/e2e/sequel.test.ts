import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, getDb, initDatabase } from '../../src/main/db/database'
import { createProject, getProjectRow } from '../../src/main/db/repo/projects'
import { getChapterArtifacts, getCurrentContent } from '../../src/main/db/repo/artifacts'
import { readLedger } from '../../src/main/pipeline/contextPack'
import { createProjectMaybeSeeded, readWorldSeed } from '../../src/main/pipeline/worldSeed'
import { startPipeline, pausePipeline, clarifySend } from '../../src/main/pipeline/controller'

process.env.MOCK_LLM = '1'
process.env.DERAUTOR_FAST_RETRY = '1'

function newProjectInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Mock Tides',
    language: 'en',
    targetWords: 4800, // clamps to MIN_CHAPTERS=8 chapters
    illustrations: true,
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

function callsForStep(projectId: string, stepKey: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ? AND job_id = ?')
      .get(projectId, stepKey) as { n: number }
  ).n
}

describe('world reuse e2e', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-sequel-'))
    dbPath = join(dir, 'test.db')
    closeDatabase()
    initDatabase(dbPath)
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.MOCK_LLM_DELAY_MS
  })

  it('writes a sequel from an inherited world', async () => {
    // Book 1: full run with illustrations, so the seed carries a style block.
    const book1 = createProject(newProjectInput())
    await clarifySend(book1.id, 'The moons are called Vel and Sorrow.')
    await runToDone(book1.id)

    const book1Calls = (
      getDb().prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ?').get(book1.id) as {
        n: number
      }
    ).n

    // Book 2 inherits the world; no world description of its own.
    const book2 = createProjectMaybeSeeded(
      newProjectInput({
        title: 'Mock Tides II',
        worldInput: '',
        premiseInput: 'Ten years later, the tide tables are true — and the sea is not.',
        sourceProjectId: book1.id
      })
    )

    const seed = readWorldSeed(book2.id)
    expect(seed).not.toBeNull()
    expect(seed!.sourceProjectId).toBe(book1.id)
    expect(seed!.chapterSummaries.length).toBe(8)
    expect(seed!.worldBible).toBe(getCurrentContent(book1.id, 'world_bible'))
    expect(seed!.imageStyleBlock).toBe(getCurrentContent(book1.id, 'image_style_block'))

    await clarifySend(book2.id, 'The sea itself has learned to lie.')
    await runToDone(book2.id)

    const p2 = getProjectRow(book2.id)
    expect(p2.stage).toBe('done')
    expect(getChapterArtifacts(book2.id, 'chapter_final').length).toBe(8)

    // Same language → style guide and image style copied, not regenerated:
    // the checkpointed copy steps make zero LLM calls.
    expect(getCurrentContent(book2.id, 'style_guide')).toBe(seed!.styleGuide)
    expect(callsForStep(book2.id, 'bible:style')).toBe(0)
    expect(getCurrentContent(book2.id, 'image_style_block')).toBe(seed!.imageStyleBlock)
    expect(callsForStep(book2.id, 'img:style')).toBe(0)
    // The rewritten world bible is a real LLM step.
    expect(callsForStep(book2.id, 'bible:world')).toBeGreaterThan(0)

    // Book 2's ledger starts fresh: only its own chapters, no bleed from book 1.
    const ledger2 = readLedger(book2.id)
    expect(ledger2.length).toBeGreaterThan(0)
    for (const e of ledger2) {
      expect(e.chapter).toBeGreaterThanOrEqual(1)
      expect(e.chapter).toBeLessThanOrEqual(8)
    }

    // Cross-project isolation: book 2's run billed nothing to book 1.
    const book1CallsAfter = (
      getDb().prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ?').get(book1.id) as {
        n: number
      }
    ).n
    expect(book1CallsAfter).toBe(book1Calls)

    // Every job ended done.
    const badJobs = getDb()
      .prepare(`SELECT step_key, status FROM jobs WHERE project_id = ? AND status != 'done'`)
      .all(book2.id)
    expect(badJobs).toEqual([])
  }, 240_000)

  it('a different language regenerates the style guide instead of copying it', async () => {
    const book1 = createProject(newProjectInput({ illustrations: false }))
    await clarifySend(book1.id, 'The moons are called Vel and Sorrow.')
    await runToDone(book1.id)

    const book2 = createProjectMaybeSeeded(
      newProjectInput({
        title: 'Mock Tides auf Deutsch',
        language: 'de',
        illustrations: false,
        worldInput: '',
        sourceProjectId: book1.id
      })
    )
    await clarifySend(book2.id, 'Same world, new tongue.')
    await runToDone(book2.id)

    expect(callsForStep(book2.id, 'bible:style')).toBeGreaterThan(0)
  }, 240_000)

  it('kill-and-resume through the seeded bible stage makes zero duplicate calls', async () => {
    const book1 = createProject(newProjectInput({ illustrations: false }))
    await clarifySend(book1.id, 'The moons are called Vel and Sorrow.')
    await runToDone(book1.id)

    process.env.MOCK_LLM_DELAY_MS = '25'
    const book2 = createProjectMaybeSeeded(
      newProjectInput({
        title: 'Mock Tides II',
        illustrations: false,
        worldInput: '',
        sourceProjectId: book1.id
      })
    )
    await clarifySend(book2.id, 'Onward.')

    startPipeline(book2.id)
    // Interrupt while the seeded bible stage is mid-flight.
    await waitFor(() => getCurrentContent(book2.id, 'world_bible') != null)
    pausePipeline(book2.id)
    await waitFor(() => getProjectRow(book2.id).status === 'paused')

    const doneBefore = getDb()
      .prepare(
        `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
         LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
         WHERE j.project_id = ? AND j.status = 'done' GROUP BY j.step_key`
      )
      .all(book2.id) as { step_key: string; calls: number }[]
    expect(doneBefore.length).toBeGreaterThan(0)

    // Simulate app restart.
    closeDatabase()
    initDatabase(dbPath)
    delete process.env.MOCK_LLM_DELAY_MS

    await runToDone(book2.id)

    const countsAfter = new Map(
      (
        getDb()
          .prepare(
            `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
             LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
             WHERE j.project_id = ? GROUP BY j.step_key`
          )
          .all(book2.id) as { step_key: string; calls: number }[]
      ).map((r) => [r.step_key, r.calls])
    )
    for (const row of doneBefore) {
      expect(countsAfter.get(row.step_key), row.step_key).toBe(row.calls)
    }
    expect(getProjectRow(book2.id).stage).toBe('done')
  }, 240_000)
})
