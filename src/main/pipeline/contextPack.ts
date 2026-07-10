import type { SystemBlock } from '../llm/types'
import type { ProjectRow } from '../db/repo/projects'
import type { WorldSeed } from './worldSeed'
import type { TranslationSeed } from './translationSeed'
import { getChapterArtifacts, getCurrentContent } from '../db/repo/artifacts'
import { countWords } from '@shared/domain'

/**
 * Assembles the byte-stable cached prefix and the volatile context for LLM calls.
 * CACHE RULE: everything inside a prefix must be deterministic — artifact
 * contents only, no timestamps, no UUIDs, no counters. The `cache: true` flag
 * marks the prompt-cache breakpoint; volatile content goes into user messages.
 */

function role(language: string): string {
  return `You are derAutor, a master novelist and story architect ghost-writing a complete book in the language "${language}". You do all preparation work (world logic, character psychology, plot mechanics, hidden events) with total rigor, and you write final prose of literary quality. You never reveal preparation material inside reader-facing prose.`
}

/** Prefix for the clarify interview and the bible stage (before the story bible exists). */
export function clarifyPrefix(project: ProjectRow): SystemBlock[] {
  return [
    {
      text: [
        role(project.language),
        `Book configuration: language "${project.language}", genre hint "${project.genre_hint}", target approximately ${project.target_words} words.`,
        `AUTHOR'S WORLD DESCRIPTION:\n${project.world_input}`,
        `AUTHOR'S STARTING PREMISE:\n${project.premise_input}`
      ].join('\n\n'),
      cache: true
    }
  ]
}

/**
 * Seeded replacement for clarifyPrefix (clarify interview + bible:brief/bible:world):
 * the inherited world bible and the previous book's ledger stand in for the
 * author's world description. Seed content is frozen at project creation, so
 * this block is byte-stable.
 */
export function seedPrefix(project: ProjectRow, seed: WorldSeed): SystemBlock[] {
  return [
    {
      text: [
        role(project.language),
        `Book configuration: language "${project.language}", genre hint "${project.genre_hint}", target approximately ${project.target_words} words.`,
        `This book continues the world of the finished book "${seed.sourceBookTitle}".`,
        `INHERITED WORLD BIBLE (state at the start of the previous book):\n${seed.worldBible}`,
        `WORLD EVENTS ESTABLISHED DURING THE PREVIOUS BOOK (settled canon; entries marked as superseding override earlier ones):\n${renderLedger(seed.ledgerEntries) || '(none recorded)'}`,
        `AUTHOR'S NOTES — WHAT'S NEW OR CHANGED:\n${project.world_input || '(none)'}`,
        `AUTHOR'S STARTING PREMISE:\n${project.premise_input}`
      ].join('\n\n'),
      cache: true
    }
  ]
}

/**
 * Post-world base for the seeded bible steps (characters/outline/style): the
 * inherited bible and ledger are DROPPED — the freshly rewritten world bible
 * replaces them — but the author's notes and premise are KEPT (the outline
 * step has no other source for the premise).
 */
export function seedBibleBase(project: ProjectRow, seed: WorldSeed): SystemBlock[] {
  return [
    {
      text: [
        role(project.language),
        `Book configuration: language "${project.language}", genre hint "${project.genre_hint}", target approximately ${project.target_words} words.`,
        `This book continues the world of the finished book "${seed.sourceBookTitle}".`,
        `AUTHOR'S NOTES — WHAT'S NEW OR CHANGED:\n${project.world_input || '(none)'}`,
        `AUTHOR'S STARTING PREMISE:\n${project.premise_input}`
      ].join('\n\n'),
      cache: true
    }
  ]
}

/**
 * The big shared prefix for every chapter/review/illustration call:
 * role + world bible + characters + outline + style guide, cache breakpoint on the last block.
 * Byte-identical across calls as long as the underlying artifacts don't change.
 */
export function storyPrefix(project: ProjectRow): SystemBlock[] {
  const worldBible = getCurrentContent(project.id, 'world_bible') ?? ''
  const characters = getCurrentContent(project.id, 'characters') ?? ''
  const outline = getCurrentContent(project.id, 'outline') ?? ''
  const styleGuide = getCurrentContent(project.id, 'style_guide') ?? ''
  return [
    { text: role(project.language) },
    { text: `# WORLD BIBLE\n${worldBible}` },
    { text: `# CHARACTER SHEETS\n${characters}` },
    { text: `# WHOLE-BOOK OUTLINE\n${outline}` },
    { text: `# STYLE GUIDE\n${styleGuide}`, cache: true }
  ]
}

/**
 * The shared prefix for every translation call: role (in the target language) +
 * the source world/character context + the agreed glossary, cache breakpoint on
 * the glossary. Byte-stable — the seed is frozen at creation and the glossary
 * artifact is written once. The volatile source chapter text goes in the user message.
 */
export function translationPrefix(
  project: ProjectRow,
  seed: TranslationSeed,
  glossaryText: string
): SystemBlock[] {
  return [
    { text: role(project.language) },
    {
      text: [
        `You are translating the finished book "${seed.sourceBookTitle}" from "${seed.sourceLanguage}" into "${seed.targetLanguage}".`,
        `# SOURCE WORLD BIBLE (for context and proper nouns; do not translate this, use it to understand the text)\n${seed.worldBible}`,
        `# SOURCE CHARACTER SHEETS\n${seed.charactersJson}`
      ].join('\n\n')
    },
    { text: `# TRANSLATION GLOSSARY\n${glossaryText}`, cache: true }
  ]
}

/** Summaries of chapters 1..uptoChapter (exclusive upper bound = uptoChapter). */
export function priorSummaries(projectId: string, uptoChapter: number): string {
  const rows = getChapterArtifacts(projectId, 'chapter_summary').filter(
    (a) => (a.chapter ?? 0) < uptoChapter
  )
  return rows.map((a) => `Chapter ${a.chapter}:\n${a.content}`).join('\n\n')
}

export function neighborSummaries(projectId: string, chapter: number): string {
  const rows = getChapterArtifacts(projectId, 'chapter_summary').filter(
    (a) => Math.abs((a.chapter ?? 0) - chapter) === 1
  )
  return rows.map((a) => `Chapter ${a.chapter}:\n${a.content}`).join('\n\n')
}

export interface LedgerEntry {
  fact: string
  kind: string
  chapter: number
  supersedes?: string
}

export function readLedger(projectId: string): LedgerEntry[] {
  const raw = getCurrentContent(projectId, 'ledger')
  if (!raw) return []
  try {
    return JSON.parse(raw) as LedgerEntry[]
  } catch {
    return []
  }
}

export function renderLedger(entries: LedgerEntry[]): string {
  return entries
    .map(
      (e) =>
        `- [${e.kind}] ${e.fact} (ch. ${e.chapter}${e.supersedes ? `, supersedes: ${e.supersedes}` : ''})`
    )
    .join('\n')
}

/** Last ~N words of the previous chapter's final prose, for voice continuity. */
export function previousTail(projectId: string, chapter: number, maxWords = 2000): string | null {
  if (chapter <= 1) return null
  const prev = getCurrentContent(projectId, 'chapter_final', chapter - 1)
  if (!prev) return null
  const words = prev.split(/\s+/)
  return words.slice(Math.max(0, words.length - maxWords)).join(' ')
}

/** The whole book as reader text, with chapter markers, for the review pass. */
export function wholeBookText(projectId: string): { text: string; words: number } {
  const chapters = getChapterArtifacts(projectId, 'chapter_final')
  const text = chapters.map((a) => `=== CHAPTER ${a.chapter} ===\n\n${a.content}`).join('\n\n')
  return { text, words: countWords(text) }
}

export function characterVisuals(projectId: string): string {
  const raw = getCurrentContent(projectId, 'characters')
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { characters?: { name: string; visualDescription: string }[] }
    return (parsed.characters ?? [])
      .map((c) => `- ${c.name}: ${c.visualDescription}`)
      .join('\n')
  } catch {
    return ''
  }
}
