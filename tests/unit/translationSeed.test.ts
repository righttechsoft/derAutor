import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDatabase, initDatabase } from '../../src/main/db/database'
import {
  createProject,
  deleteProject,
  getProjectRow,
  listProjectRows,
  toSummary,
  updateProject
} from '../../src/main/db/repo/projects'
import { getCurrentContent, saveArtifact } from '../../src/main/db/repo/artifacts'
import { listImages, saveImage } from '../../src/main/db/repo/images'
import {
  buildTranslationSeed,
  createProjectTranslation,
  readTranslationSeed
} from '../../src/main/pipeline/translationSeed'

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

/** A finished source book with the artifacts a translation needs. */
function makeDoneSource(withImage = false): string {
  const p = createProject(baseInput())
  saveArtifact(p.id, 'world_bible', null, 'WORLD BIBLE: two moons, spoken-word magic.')
  saveArtifact(
    p.id,
    'characters',
    null,
    JSON.stringify({ characters: [{ name: 'Aran', visualDescription: 'wiry, salt-bleached hair' }] })
  )
  saveArtifact(p.id, 'style_guide', null, 'STYLE: close third person, present tense.')
  saveArtifact(
    p.id,
    'outline',
    null,
    JSON.stringify({
      bookTitle: 'The Falsified Tides',
      chapters: [
        { index: 1, title: 'The Wrong Tide' },
        { index: 2, title: 'The Flood' }
      ]
    })
  )
  saveArtifact(p.id, 'book_meta', null, JSON.stringify({ annotation: 'A blurb.', fb2Genre: 'sf_fantasy', authorPseudonym: 'A. Source' }))
  saveArtifact(p.id, 'chapter_final', 1, 'Aran finds the tables. It is chapter one.')
  saveArtifact(p.id, 'chapter_final', 2, 'The city floods. It is chapter two.')
  if (withImage) {
    saveImage(p.id, 'cover', null, 'a cover', Buffer.from([1, 2, 3]), 1024, 1536)
    saveImage(p.id, 'chapter', 1, 'ch1 image', Buffer.from([4, 5, 6]), 1536, 1024)
  }
  updateProject(p.id, { stage: 'done', status: 'done' })
  return p.id
}

describe('translationSeed', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'derautor-tseed-'))
    closeDatabase()
    initDatabase(join(dir, 'test.db'))
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('builds a complete seed from a finished source', () => {
    const sourceId = makeDoneSource()
    const seed = buildTranslationSeed(sourceId, 'ru')
    expect(seed.sourceProjectId).toBe(sourceId)
    expect(seed.sourceTitle).toBe('Source Book')
    expect(seed.sourceBookTitle).toBe('The Falsified Tides')
    expect(seed.sourceLanguage).toBe('en')
    expect(seed.targetLanguage).toBe('ru')
    expect(seed.worldBible).toContain('two moons')
    expect(seed.chapters).toEqual([
      { chapter: 1, title: 'The Wrong Tide', content: 'Aran finds the tables. It is chapter one.' },
      { chapter: 2, title: 'The Flood', content: 'The city floods. It is chapter two.' }
    ])
    expect(JSON.parse(seed.bookMetaJson as string).annotation).toBe('A blurb.')
  })

  it('rejects an unfinished source', () => {
    const p = createProject(baseInput())
    expect(() => buildTranslationSeed(p.id, 'ru')).toThrow(/not finished/)
  })

  it('rejects a finished source with no chapters', () => {
    const p = createProject(baseInput())
    saveArtifact(p.id, 'world_bible', null, 'WB')
    saveArtifact(p.id, 'characters', null, '{}')
    saveArtifact(p.id, 'style_guide', null, 'SG')
    saveArtifact(p.id, 'outline', null, JSON.stringify({ bookTitle: 'T' }))
    updateProject(p.id, { stage: 'done', status: 'done' })
    expect(() => buildTranslationSeed(p.id, 'ru')).toThrow(/no chapters/)
  })

  it('snapshots the seed, copies images, starts at glossary, and survives source deletion', () => {
    const sourceId = makeDoneSource(true)
    const tr = createProjectTranslation(
      baseInput({ title: 'Source Book (ru)', language: 'ru', illustrations: false, sourceProjectId: sourceId, mode: 'translation' })
    )

    expect(getCurrentContent(tr.id, 'translation_seed')).toBeTruthy()
    expect(tr.stage).toBe('glossary')
    expect(tr.chapter_count).toBe(2)
    expect(listImages(tr.id).length).toBe(listImages(sourceId).length)
    expect(listImages(tr.id).length).toBe(2)

    const summary = toSummary(getProjectRow(tr.id))
    expect(summary.isTranslation).toBe(true)
    expect(summary.sourceTitle).toBe('Source Book')

    // Frozen snapshot: deleting the source leaves the translation fully intact.
    deleteProject(sourceId)
    expect(toSummary(getProjectRow(tr.id)).sourceTitle).toBeNull()
    const seed = readTranslationSeed(tr.id)
    expect(seed?.chapters.length).toBe(2)
    expect(seed?.worldBible).toContain('two moons')
  })

  it('rolls back the whole creation when the source is invalid', () => {
    const p = createProject(baseInput())
    expect(() =>
      createProjectTranslation(baseInput({ title: 'X (ru)', language: 'ru', sourceProjectId: p.id, mode: 'translation' }))
    ).toThrow(/not finished/)
    expect(listProjectRows().length).toBe(1) // the half-created translation is gone too
  })
})
