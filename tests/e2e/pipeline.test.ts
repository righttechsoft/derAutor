import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, getDb, initDatabase } from '../../src/main/db/database'
import { createProject, getProjectRow } from '../../src/main/db/repo/projects'
import { getChapterArtifacts, getCurrentContent } from '../../src/main/db/repo/artifacts'
import { listImages } from '../../src/main/db/repo/images'
import { startPipeline, pausePipeline, clarifySend } from '../../src/main/pipeline/controller'
import { buildFb2 } from '../../src/main/export/fb2'
import { create } from 'xmlbuilder2'

process.env.MOCK_LLM = '1'
process.env.DERAUTOR_FAST_RETRY = '1'

function newProjectInput(illustrations: boolean) {
  return {
    title: 'Mock Tides',
    language: 'en',
    targetWords: 4800, // clamps to MIN_CHAPTERS=8 chapters of ~600 words
    illustrations,
    genreHint: 'maritime fantasy',
    worldInput: 'A harbor city ruled by tides. Two moons. Spoken-word magic.',
    premiseInput: 'A young tinkerer notices the tide tables have been falsified.'
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('mock pipeline e2e', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-e2e-'))
    dbPath = join(dir, 'test.db')
    closeDatabase()
    initDatabase(dbPath)
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.MOCK_LLM_DELAY_MS
  })

  it('writes a complete book end-to-end and exports valid FB2', async () => {
    const project = createProject(newProjectInput(true))
    await clarifySend(project.id, 'The moons are called Vel and Sorrow.')

    startPipeline(project.id)
    await waitFor(() => {
      const p = getProjectRow(project.id)
      if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
      return p.status === 'done'
    })

    const p = getProjectRow(project.id)
    expect(p.stage).toBe('done')
    expect(p.chapter_count).toBe(8)

    const finals = getChapterArtifacts(project.id, 'chapter_final')
    expect(finals.length).toBe(8)
    const summaries = getChapterArtifacts(project.id, 'chapter_summary')
    expect(summaries.length).toBe(8)

    // Mock review flags chapters 1 and 2 in round 1 → both rewritten (version 2)
    const rewritten = finals.filter((a) => a.version > 1).map((a) => a.chapter)
    expect(rewritten.sort()).toEqual([1, 2])
    const issueRows = getDb()
      .prepare(`SELECT status, COUNT(*) AS n FROM review_issues WHERE project_id = ? GROUP BY status`)
      .all(project.id) as { status: string; n: number }[]
    expect(issueRows).toEqual([{ status: 'fixed', n: 2 }])

    // Backbone artifacts exist and stay hidden until the author's room unlock
    for (const kind of ['clarify_brief', 'world_bible', 'characters', 'outline', 'style_guide', 'ledger', 'book_meta'] as const) {
      expect(getCurrentContent(project.id, kind), kind).toBeTruthy()
    }

    // Illustrations: cover + one per chapter
    const images = listImages(project.id)
    expect(images.filter((i) => i.kind === 'cover').length).toBe(1)
    expect(images.filter((i) => i.kind === 'chapter').length).toBe(8)

    // FB2 assembles and parses; contains all binaries
    const xml = buildFb2(project.id)
    expect(() => create(xml)).not.toThrow()
    expect(xml).toContain('<coverpage>')
    expect((xml.match(/<binary /g) ?? []).length).toBe(9)

    // Every job ended done
    const badJobs = getDb()
      .prepare(`SELECT step_key, status FROM jobs WHERE project_id = ? AND status != 'done'`)
      .all(project.id)
    expect(badJobs).toEqual([])
  }, 120_000)

  it('kill-and-resume: pause mid-chapters, reopen DB, resume with zero duplicate calls', async () => {
    process.env.MOCK_LLM_DELAY_MS = '25'
    const project = createProject(newProjectInput(false))

    startPipeline(project.id)
    // Wait until at least 2 chapters are final, then interrupt mid-flight
    await waitFor(() => getChapterArtifacts(project.id, 'chapter_final').length >= 2)
    pausePipeline(project.id)
    await waitFor(() => getProjectRow(project.id).status === 'paused')

    // Snapshot per-step llm_call counts for completed jobs
    const doneBefore = getDb()
      .prepare(
        `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
         LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
         WHERE j.project_id = ? AND j.status = 'done' GROUP BY j.step_key`
      )
      .all(project.id) as { step_key: string; calls: number }[]
    expect(doneBefore.length).toBeGreaterThan(2)

    // Simulate app restart: close and reopen the database file
    closeDatabase()
    initDatabase(dbPath)
    delete process.env.MOCK_LLM_DELAY_MS

    startPipeline(project.id)
    await waitFor(() => {
      const p = getProjectRow(project.id)
      if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
      return p.status === 'done'
    })

    // Completed steps were skipped on resume: their call counts are unchanged
    const countsAfter = new Map(
      (
        getDb()
          .prepare(
            `SELECT j.step_key, COUNT(l.id) AS calls FROM jobs j
             LEFT JOIN llm_calls l ON l.job_id = j.step_key AND l.project_id = j.project_id
             WHERE j.project_id = ? GROUP BY j.step_key`
          )
          .all(project.id) as { step_key: string; calls: number }[]
      ).map((r) => [r.step_key, r.calls])
    )
    for (const row of doneBefore) {
      expect(countsAfter.get(row.step_key), row.step_key).toBe(row.calls)
    }

    expect(getChapterArtifacts(project.id, 'chapter_final').length).toBe(8)
    expect(getProjectRow(project.id).stage).toBe('done')
  }, 120_000)
})
