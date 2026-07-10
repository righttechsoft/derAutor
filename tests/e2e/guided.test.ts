import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, getDb, initDatabase } from '../../src/main/db/database'
import { createProject, getProjectRow } from '../../src/main/db/repo/projects'
import { getCurrentContent } from '../../src/main/db/repo/artifacts'
import { listUnlockedArtifacts, readUnlockedArtifact } from '../../src/main/services/spoilerGate'
import {
  guidedApprove,
  guidedCurrent,
  guidedEdit,
  guidedRefine,
  guidedRegenerate,
  guidedRunFree
} from '../../src/main/pipeline/guided'
import { startPipeline, clarifySend } from '../../src/main/pipeline/controller'

process.env.MOCK_LLM = '1'
process.env.DERAUTOR_FAST_RETRY = '1'

function newProjectInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Guided Tides',
    language: 'en',
    targetWords: 4800, // clamps to 8 chapters
    illustrations: false,
    genreHint: 'maritime fantasy',
    worldInput: 'A harbor city ruled by tides. Two moons. Spoken-word magic.',
    premiseInput: 'A young tinkerer notices the tide tables have been falsified.',
    guided: true,
    ...overrides
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Waits until the project is awaiting the author or done (throws on pipeline error). */
async function settle(projectId: string): Promise<'awaiting' | 'done'> {
  await waitFor(() => {
    const p = getProjectRow(projectId)
    if (p.status === 'error') throw new Error(`pipeline error: ${p.error}`)
    return p.status === 'awaiting' || p.status === 'done'
  })
  return getProjectRow(projectId).status as 'awaiting' | 'done'
}

function callsForStep(projectId: string, stepKey: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE project_id = ? AND job_id = ?')
      .get(projectId, stepKey) as { n: number }
  ).n
}

describe('guided mode e2e', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-guided-'))
    closeDatabase()
    initDatabase(join(dir, 'test.db'))
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stops after every step, exposes content live, and finishes via approvals', async () => {
    const p = createProject(newProjectInput())
    await clarifySend(p.id, 'The moons are called Vel and Sorrow.')

    startPipeline(p.id)
    let approvals = 0
    for (;;) {
      const state = await settle(p.id)
      if (state === 'done') break

      // A step is pending and its content is readable mid-run (spoiler gate bypassed).
      const pending = guidedCurrent(p.id)
      expect(pending).not.toBeNull()
      expect(pending!.content.length).toBeGreaterThan(0)
      const metas = listUnlockedArtifacts(p.id)
      expect(metas.length).toBeGreaterThan(0)
      expect(readUnlockedArtifact(p.id, metas[0].id).length).toBeGreaterThan(0)

      guidedApprove(p.id)
      approvals++
      if (approvals > 200) throw new Error('runaway approval loop')
    }

    expect(getProjectRow(p.id).stage).toBe('done')
    // bible (5) + 8 chapters * (plan/prose/summary=3) + review fixes + book meta.
    expect(approvals).toBeGreaterThan(20)
    expect(getProjectRow(p.id).pending_step).toBeTruthy() // last committed step
    // Every job ended done; no duplicates.
    const badJobs = getDb()
      .prepare(`SELECT step_key FROM jobs WHERE project_id = ? AND status != 'done'`)
      .all(p.id)
    expect(badJobs).toEqual([])
  }, 240_000)

  it('regenerate re-runs the pending step', async () => {
    const p = createProject(newProjectInput())
    await clarifySend(p.id, 'x')
    startPipeline(p.id)
    await settle(p.id)
    expect(getProjectRow(p.id).pending_step).toBe('bible:brief')
    expect(callsForStep(p.id, 'bible:brief')).toBe(1)

    guidedRegenerate(p.id)
    await settle(p.id)
    expect(getProjectRow(p.id).pending_step).toBe('bible:brief')
    expect(callsForStep(p.id, 'bible:brief')).toBe(2)
  }, 120_000)

  it('edit replaces the pending artifact with the author text', async () => {
    const p = createProject(newProjectInput())
    await clarifySend(p.id, 'x')
    startPipeline(p.id)
    await settle(p.id)

    const edited = JSON.stringify({ worldFacts: ['edited by author'], premiseRefinements: [], constraints: [], tone: 'edited' })
    const after = guidedEdit(p.id, edited)
    expect(after?.content).toBe(edited)
    expect(getCurrentContent(p.id, 'clarify_brief')).toBe(edited)
  }, 120_000)

  it('refine saves a new version and records a call', async () => {
    const p = createProject(newProjectInput())
    await clarifySend(p.id, 'x')
    startPipeline(p.id)
    await settle(p.id)

    const before = callsForStep(p.id, 'bible:brief')
    await guidedRefine(p.id, 'Add a third moon to the world facts.')
    // A new current version exists (mock returns the canned brief) and the chat is recorded.
    const briefVersions = listUnlockedArtifacts(p.id).filter((a) => a.kind === 'clarify_brief')
    expect(briefVersions.length).toBe(2)
    const pending = guidedCurrent(p.id)
    expect(pending!.messages.length).toBe(2) // user + assistant
    expect(callsForStep(p.id, 'bible:brief')).toBe(before + 1)
  }, 120_000)

  it('run without stopping finishes the book and clears guided', async () => {
    const p = createProject(newProjectInput())
    await clarifySend(p.id, 'x')
    startPipeline(p.id)
    await settle(p.id)

    guidedRunFree(p.id)
    await waitFor(() => {
      const pr = getProjectRow(p.id)
      if (pr.status === 'error') throw new Error(pr.error ?? 'error')
      return pr.status === 'done'
    })
    expect(getProjectRow(p.id).stage).toBe('done')
    expect(getProjectRow(p.id).guided).toBe(0)
  }, 240_000)
})
