import type { NewProjectInput } from '@shared/domain'
import { inTransaction } from '../db/database'
import { getChapterArtifacts, getCurrentContent, saveArtifact } from '../db/repo/artifacts'
import { copyImages } from '../db/repo/images'
import type { ProjectRow } from '../db/repo/projects'
import { createProject, getProjectRow, updateProject } from '../db/repo/projects'

/**
 * Translation: a new book translates a FINISHED source project into another
 * language. Like world reuse, everything the translation pipeline needs from the
 * source — every chapter's prose, the outline, book metadata, world/character
 * context for the glossary — is snapshotted into ONE 'translation_seed' artifact
 * on the new project at creation time, inside the same transaction as the project
 * row, and NEVER written again. That frozen snapshot keeps every derived step
 * hash stable across resume and makes deleting the source project harmless.
 */
export interface TranslationSeed {
  sourceProjectId: string
  sourceTitle: string
  /** The published book title (from the source outline), falling back to the project title. */
  sourceBookTitle: string
  sourceLanguage: string
  targetLanguage: string
  genreHint: string
  worldBible: string
  charactersJson: string
  styleGuide: string
  /** The source outline JSON verbatim — cloned and re-titled to build the translated outline. */
  outlineJson: string
  /** The source book_meta JSON verbatim (annotation/fb2Genre/authorPseudonym), or null. */
  bookMetaJson: string | null
  /** Every source chapter's reader prose, with its source-language title. */
  chapters: { chapter: number; title: string; content: string }[]
}

function outlineTitleMap(outlineJson: string): Map<number, string> {
  const titles = new Map<number, string>()
  try {
    const data = JSON.parse(outlineJson) as { chapters?: { index?: unknown; title?: unknown }[] }
    for (const ch of data.chapters ?? []) {
      if (typeof ch.index === 'number' && typeof ch.title === 'string') titles.set(ch.index, ch.title)
    }
  } catch {
    // tolerate an unreadable outline — titles just fall back to empty strings
  }
  return titles
}

export function buildTranslationSeed(sourceProjectId: string, targetLanguage: string): TranslationSeed {
  const source: ProjectRow = getProjectRow(sourceProjectId)
  if (source.stage !== 'done') {
    throw new Error(`The source book "${source.title}" is not finished yet — only finished books can be translated.`)
  }
  const worldBible = getCurrentContent(sourceProjectId, 'world_bible')
  const charactersJson = getCurrentContent(sourceProjectId, 'characters')
  const styleGuide = getCurrentContent(sourceProjectId, 'style_guide')
  const outlineJson = getCurrentContent(sourceProjectId, 'outline')
  if (!worldBible || !charactersJson || !styleGuide || !outlineJson) {
    throw new Error(`The source book "${source.title}" is missing artifacts required to translate it.`)
  }

  const finals = getChapterArtifacts(sourceProjectId, 'chapter_final').filter((a) => a.chapter != null)
  if (finals.length === 0) {
    throw new Error(`The source book "${source.title}" has no chapters to translate.`)
  }

  let sourceBookTitle = source.title
  try {
    const outline = JSON.parse(outlineJson) as { bookTitle?: string }
    if (outline.bookTitle) sourceBookTitle = outline.bookTitle
  } catch {
    // project title is a fine fallback
  }

  const titles = outlineTitleMap(outlineJson)
  return {
    sourceProjectId,
    sourceTitle: source.title,
    sourceBookTitle,
    sourceLanguage: source.language,
    targetLanguage,
    genreHint: source.genre_hint,
    worldBible,
    charactersJson,
    styleGuide,
    outlineJson,
    bookMetaJson: getCurrentContent(sourceProjectId, 'book_meta'),
    chapters: finals.map((a) => ({
      chapter: a.chapter as number,
      title: titles.get(a.chapter as number) ?? '',
      content: a.content
    }))
  }
}

/**
 * Creates a translation project: snapshots the translation_seed, copies the
 * source book's images, and starts it at the 'glossary' stage — all in one
 * transaction, so a failure leaves nothing half-created.
 */
export function createProjectTranslation(input: NewProjectInput): ProjectRow {
  if (!input.sourceProjectId) throw new Error('A translation needs a source book.')
  return inTransaction(() => {
    const row = createProject(input)
    const seed = buildTranslationSeed(input.sourceProjectId as string, input.language)
    saveArtifact(row.id, 'translation_seed', null, JSON.stringify(seed, null, 2))
    copyImages(input.sourceProjectId as string, row.id)
    updateProject(row.id, { stage: 'glossary', chapter_count: seed.chapters.length })
    return getProjectRow(row.id)
  })
}

export function readTranslationSeed(projectId: string): TranslationSeed | null {
  const raw = getCurrentContent(projectId, 'translation_seed')
  if (!raw) return null
  try {
    return JSON.parse(raw) as TranslationSeed
  } catch {
    return null
  }
}
