import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, initDatabase } from '../../src/main/db/database'
import { createProject, deleteProject, getProjectRow, listProjectRows, toSummary, updateProject } from '../../src/main/db/repo/projects'
import { getCurrentContent, saveArtifact } from '../../src/main/db/repo/artifacts'
import { buildWorldSeed, createProjectMaybeSeeded, readWorldSeed } from '../../src/main/pipeline/worldSeed'

process.env.MOCK_LLM = '1'

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Source Book',
    language: 'en',
    targetWords: 4800,
    illustrations: false,
    genreHint: 'maritime fantasy',
    worldInput: 'A harbor city ruled by tides.',
    premiseInput: 'A tinkerer notices falsified tide tables.',
    ...overrides
  }
}

/** A hand-assembled finished project with the artifacts a seed needs. */
function makeDoneSource(): string {
  const p = createProject(baseInput())
  saveArtifact(p.id, 'world_bible', null, 'WORLD BIBLE: two moons, spoken-word magic.')
  saveArtifact(p.id, 'characters', null, JSON.stringify({ characters: [{ name: 'Aran', visualDescription: 'wiry, salt-bleached hair' }] }))
  saveArtifact(p.id, 'style_guide', null, 'STYLE: close third person, present tense.')
  saveArtifact(p.id, 'outline', null, JSON.stringify({ bookTitle: 'The Falsified Tides' }))
  saveArtifact(p.id, 'ledger', null, JSON.stringify([{ fact: 'The harbor master died.', kind: 'other', chapter: 7 }]))
  saveArtifact(p.id, 'chapter_summary', 1, 'Aran finds the tables.')
  saveArtifact(p.id, 'chapter_summary', 2, 'The city floods.')
  updateProject(p.id, { stage: 'done', status: 'done' })
  return p.id
}

describe('worldSeed', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-seed-'))
    closeDatabase()
    initDatabase(join(dir, 'test.db'))
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds a complete seed from a finished project', () => {
    const sourceId = makeDoneSource()
    const seed = buildWorldSeed(sourceId)
    expect(seed.sourceProjectId).toBe(sourceId)
    expect(seed.sourceTitle).toBe('Source Book')
    expect(seed.sourceBookTitle).toBe('The Falsified Tides')
    expect(seed.language).toBe('en')
    expect(seed.worldBible).toContain('two moons')
    expect(JSON.parse(seed.charactersJson).characters[0].name).toBe('Aran')
    expect(seed.styleGuide).toContain('close third person')
    expect(seed.ledgerEntries).toEqual([{ fact: 'The harbor master died.', kind: 'other', chapter: 7 }])
    expect(seed.chapterSummaries).toEqual([
      { chapter: 1, content: 'Aran finds the tables.' },
      { chapter: 2, content: 'The city floods.' }
    ])
    expect(seed.imageStyleBlock).toBeNull()
  })

  it('tolerates a missing ledger and picks up an image style block', () => {
    const p = createProject(baseInput())
    saveArtifact(p.id, 'world_bible', null, 'WB')
    saveArtifact(p.id, 'characters', null, '{}')
    saveArtifact(p.id, 'style_guide', null, 'SG')
    saveArtifact(p.id, 'image_style_block', null, 'oil painting, teal palette')
    updateProject(p.id, { stage: 'done', status: 'done' })
    const seed = buildWorldSeed(p.id)
    expect(seed.ledgerEntries).toEqual([])
    expect(seed.chapterSummaries).toEqual([])
    expect(seed.imageStyleBlock).toBe('oil painting, teal palette')
    expect(seed.sourceBookTitle).toBe('Source Book') // outline missing → project title
  })

  it('rejects an unfinished source', () => {
    const p = createProject(baseInput())
    expect(() => buildWorldSeed(p.id)).toThrow(/not finished/)
  })

  it('snapshots the seed at creation and survives source deletion', () => {
    const sourceId = makeDoneSource()
    const book2 = createProjectMaybeSeeded(
      baseInput({ title: 'Sequel', worldInput: '', sourceProjectId: sourceId })
    )
    expect(getCurrentContent(book2.id, 'world_seed')).toBeTruthy()
    expect(toSummary(getProjectRow(book2.id)).sourceTitle).toBe('Source Book')

    deleteProject(sourceId)
    expect(toSummary(getProjectRow(book2.id)).sourceTitle).toBeNull()
    const seed = readWorldSeed(book2.id)
    expect(seed?.worldBible).toContain('two moons')
  })

  it('creates no seed (and no project) when the source is invalid', () => {
    const p = createProject(baseInput())
    expect(() =>
      createProjectMaybeSeeded(baseInput({ title: 'Sequel', sourceProjectId: p.id }))
    ).toThrow(/not finished/)
    // The whole transaction rolled back: the half-created sequel is gone too.
    expect(listProjectRows().length).toBe(1)
  })
})
