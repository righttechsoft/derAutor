import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, getDb, initDatabase } from '../../src/main/db/database'
import { createProject, getProjectRow } from '../../src/main/db/repo/projects'
import { getChapterArtifacts, getCurrentContent } from '../../src/main/db/repo/artifacts'
import { listImages } from '../../src/main/db/repo/images'
import { createProjectTranslation, readTranslationSeed } from '../../src/main/pipeline/translationSeed'
import { startPipeline, pausePipeline, clarifySend } from '../../src/main/pipeline/controller'
import { buildFb2 } from '../../src/main/export/fb2'

process.env.MOCK_LLM = '1'
process.env.DERAUTOR_FAST_RETRY = '1'

function newProjectInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Mock Tides',
    language: 'en',
    targetWords: 4800, // clamps to MIN_CHAPTERS=8 chapters
    illustrations: true, // so the source has images to copy
    genreHint: 'maritime fantasy',
    worldInput: 'A harbor city ruled by tides. Two moons. Spoken-word magic.',
    premiseInput: 'A young tinkerer notices the tide tables have been falsified.',
    ...overrides
  }
}

function translationInput(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    title: 'Mock Tides (Deutsch)',
    language: 'de',
    targetWords: 4800,
    illustrations: false,
    genreHint: '',
    worldInput: '',
    premiseInput: '',
    sourceProjectId: sourceId,
    mode: 'translation' as const,
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

describe('translation e2e', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-translation-'))
    dbPath = join(dir, 'test.db')
    closeDatabase()
    initDatabase(dbPath)
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.MOCK_LLM_DELAY_MS
  })

  it('translates a finished book end to end', async () => {
    // Source book: full run with illustrations, so there are images to copy.
    const source = createProject(newProjectInput())
    await clarifySend(source.id, 'The moons are called Vel and Sorrow.')
    await runToDone(source.id)

    const sourceCalls = (
      getDb().prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ?').get(source.id) as {
        n: number
      }
    ).n
    const sourceChapters = getChapterArtifacts(source.id, 'chapter_final').length
    expect(sourceChapters).toBe(8)

    // Create the translation (snapshots the seed, copies images, starts at glossary).
    const tr = createProjectTranslation(translationInput(source.id))
    const seed = readTranslationSeed(tr.id)
    expect(seed).not.toBeNull()
    expect(seed!.sourceLanguage).toBe('en')
    expect(seed!.targetLanguage).toBe('de')
    expect(seed!.chapters.length).toBe(8)
    expect(getProjectRow(tr.id).stage).toBe('glossary')
    expect(getProjectRow(tr.id).chapter_count).toBe(8)
    // Images copied from the source at creation.
    expect(listImages(tr.id).length).toBe(listImages(source.id).length)
    expect(listImages(tr.id).length).toBeGreaterThan(0)

    await runToDone(tr.id)

    const p = getProjectRow(tr.id)
    expect(p.stage).toBe('done')
    expect(getChapterArtifacts(tr.id, 'chapter_final').length).toBe(8)
    // The translation produced its own glossary, outline, and book metadata.
    expect(getCurrentContent(tr.id, 'translation_glossary')).toBeTruthy()
    const outline = JSON.parse(getCurrentContent(tr.id, 'outline') as string)
    expect(outline.bookTitle).toContain('translated')
    expect(getCurrentContent(tr.id, 'book_meta')).toBeTruthy()

    // FB2 exports in the target language with the copied cover.
    const fb2 = buildFb2(tr.id)
    expect(fb2).toContain('<lang>de</lang>')
    expect(fb2).toContain('l:href')

    // Cross-project isolation: the translation billed nothing to the source.
    const sourceCallsAfter = (
      getDb().prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ?').get(source.id) as {
        n: number
      }
    ).n
    expect(sourceCallsAfter).toBe(sourceCalls)

    // Every job ended done.
    const badJobs = getDb()
      .prepare(`SELECT step_key, status FROM jobs WHERE project_id = ? AND status != 'done'`)
      .all(tr.id)
    expect(badJobs).toEqual([])
  }, 240_000)

  it('kill-and-resume mid-translation makes zero duplicate calls', async () => {
    const source = createProject(newProjectInput({ illustrations: false }))
    await clarifySend(source.id, 'The moons are called Vel and Sorrow.')
    await runToDone(source.id)

    process.env.MOCK_LLM_DELAY_MS = '25'
    const tr = createProjectTranslation(translationInput(source.id))

    startPipeline(tr.id)
    // Interrupt after the glossary + first chapter have landed.
    await waitFor(() => getCurrentContent(tr.id, 'chapter_final', 1) != null)
    pausePipeline(tr.id)
    await waitFor(() => getProjectRow(tr.id).status === 'paused')

    const doneBefore = getDb()
      .prepare(
        `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
         LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
         WHERE j.project_id = ? AND j.status = 'done' GROUP BY j.step_key`
      )
      .all(tr.id) as { step_key: string; calls: number }[]
    expect(doneBefore.length).toBeGreaterThan(0)

    // Simulate app restart.
    closeDatabase()
    initDatabase(dbPath)
    delete process.env.MOCK_LLM_DELAY_MS

    await runToDone(tr.id)

    const countsAfter = new Map(
      (
        getDb()
          .prepare(
            `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
             LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
             WHERE j.project_id = ? GROUP BY j.step_key`
          )
          .all(tr.id) as { step_key: string; calls: number }[]
      ).map((r) => [r.step_key, r.calls])
    )
    for (const row of doneBefore) {
      expect(countsAfter.get(row.step_key), row.step_key).toBe(row.calls)
    }
    expect(getProjectRow(tr.id).stage).toBe('done')
  }, 240_000)
})
