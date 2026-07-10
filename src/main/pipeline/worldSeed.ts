import type { NewProjectInput } from '@shared/domain'
import { inTransaction } from '../db/database'
import { getChapterArtifacts, getCurrentContent, saveArtifact } from '../db/repo/artifacts'
import type { ProjectRow } from '../db/repo/projects'
import { createProject, getProjectRow } from '../db/repo/projects'
import type { LedgerEntry } from './contextPack'
import { readLedger } from './contextPack'

/**
 * World reuse: a new book can continue the world of a FINISHED project.
 * Everything the pipeline needs from the source is snapshotted into ONE
 * 'world_seed' artifact on the new project at creation time — inside the same
 * transaction as the project row, and NEVER written again afterwards. That
 * invariant keeps the seeded/non-seeded pipeline branch (and every step hash
 * derived from the seed) stable across resume, and makes deleting the source
 * project harmless.
 *
 * Chaining works for free: book 3 seeded from book 2 reads book 2's world
 * bible (already the post-book-1 state) plus book 2's own ledger.
 */
export interface WorldSeed {
  sourceProjectId: string
  /** The source project's working title. */
  sourceTitle: string
  /** The published book title (from the outline), falling back to the project title. */
  sourceBookTitle: string
  language: string
  genreHint: string
  worldBible: string
  charactersJson: string
  styleGuide: string
  /** Raw ledger entries — kind/chapter/supersedes kept so prompts can treat superseding entries as overrides. */
  ledgerEntries: LedgerEntry[]
  chapterSummaries: { chapter: number; content: string }[]
  imageStyleBlock: string | null
}

export function buildWorldSeed(sourceProjectId: string): WorldSeed {
  const source: ProjectRow = getProjectRow(sourceProjectId)
  if (source.stage !== 'done') {
    throw new Error(`The source book "${source.title}" is not finished yet — only finished books can seed a new world.`)
  }
  const worldBible = getCurrentContent(sourceProjectId, 'world_bible')
  const charactersJson = getCurrentContent(sourceProjectId, 'characters')
  const styleGuide = getCurrentContent(sourceProjectId, 'style_guide')
  if (!worldBible || !charactersJson || !styleGuide) {
    throw new Error(`The source book "${source.title}" is missing its world bible artifacts.`)
  }

  let sourceBookTitle = source.title
  try {
    const outline = JSON.parse(getCurrentContent(sourceProjectId, 'outline') ?? '{}') as {
      bookTitle?: string
    }
    if (outline.bookTitle) sourceBookTitle = outline.bookTitle
  } catch {
    // tolerate an unreadable outline — the project title is a fine fallback
  }

  return {
    sourceProjectId,
    sourceTitle: source.title,
    sourceBookTitle,
    language: source.language,
    genreHint: source.genre_hint,
    worldBible,
    charactersJson,
    styleGuide,
    ledgerEntries: readLedger(sourceProjectId),
    chapterSummaries: getChapterArtifacts(sourceProjectId, 'chapter_summary')
      .filter((a) => a.chapter != null)
      .map((a) => ({ chapter: a.chapter as number, content: a.content })),
    imageStyleBlock: getCurrentContent(sourceProjectId, 'image_style_block')
  }
}

/** Creates a project; when sourceProjectId is set, snapshots the world_seed in the same transaction. */
export function createProjectMaybeSeeded(input: NewProjectInput): ProjectRow {
  return inTransaction(() => {
    const row = createProject(input)
    if (input.sourceProjectId) {
      const seed = buildWorldSeed(input.sourceProjectId)
      saveArtifact(row.id, 'world_seed', null, JSON.stringify(seed, null, 2))
    }
    return row
  })
}

export function readWorldSeed(projectId: string): WorldSeed | null {
  const raw = getCurrentContent(projectId, 'world_seed')
  if (!raw) return null
  try {
    return JSON.parse(raw) as WorldSeed
  } catch {
    return null
  }
}

export function renderSeedSummaries(seed: WorldSeed): string {
  return seed.chapterSummaries.map((s) => `Chapter ${s.chapter}:\n${s.content}`).join('\n\n')
}
