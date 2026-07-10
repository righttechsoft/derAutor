export const STAGES = [
  'intake',
  'clarify',
  'bible',
  'chapters',
  'review',
  'illustrate',
  'align',
  'export',
  // Translation track (a derived project runs these instead of the original track).
  'glossary',
  'translate',
  'tcheck',
  'done'
] as const
export type Stage = (typeof STAGES)[number]

/** Stages that make up a translation project's pipeline (its own track, no overlap with originals). */
export const TRANSLATION_STAGES = ['glossary', 'translate', 'tcheck', 'done'] as const

export type ProjectStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'error'
  | 'cancelled'
  | 'done'
  /** Guided mode: a step finished and is waiting for the author's approve/regenerate/edit/refine. */
  | 'awaiting'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export type ArtifactKind =
  | 'clarify_brief'
  | 'world_bible'
  | 'characters'
  | 'outline'
  | 'style_guide'
  | 'chapter_plan'
  | 'chapter_final'
  | 'chapter_summary'
  | 'ledger'
  | 'review_chunk'
  | 'image_style_block'
  | 'image_style_override'
  | 'image_prompt'
  | 'book_meta'
  | 'world_seed'
  | 'translation_seed'
  | 'translation_glossary'

export interface NewProjectInput {
  title: string
  language: string // BCP-47, e.g. 'en', 'ru', 'de'
  targetWords: number
  illustrations: boolean
  genreHint: string
  worldInput: string
  premiseInput: string
  /** Free-text authorial style directive (voice, register, hard prose rules); folded into the style guide. */
  styleInput?: string
  /** Inherit the world of a finished project (its world bible + accumulated changes). */
  sourceProjectId?: string | null
  /**
   * Transient discriminator, not persisted. 'translation' makes a derived
   * project that translates the finished `sourceProjectId` book into `language`
   * (skips clarify/bible/prose-generation). Absent = a normal or sequel project.
   */
  mode?: 'translation'
  /** Guided (co-writing) mode: the pipeline stops after each step for the author to approve/refine. */
  guided?: boolean
}

export interface ProjectSummary {
  id: string
  title: string
  /** The generated book title (from the outline), revealed only once the book is done; null otherwise. */
  bookTitle: string | null
  language: string
  targetWords: number
  illustrations: boolean
  genreHint: string
  stage: Stage
  status: ProjectStatus
  chapterCount: number | null
  chaptersDone: number
  reviewRound: number
  authorsRoomUnlocked: boolean
  wordsWritten: number
  costUsd: number
  error: string | null
  sourceProjectId: string | null
  /** Title of the source project whose world this book continues (null if none/deleted). */
  sourceTitle: string | null
  /** True when this project is a translation of `sourceProjectId` (has a translation_seed artifact). */
  isTranslation: boolean
  /** True when this project is a named edit variant clone of a finished book. */
  isEditCopy: boolean
  /** User-given name for this edit variant (null for non-variants). */
  editLabel: string | null
  /** Guided (co-writing) mode: the pipeline stops after each step for author approval/refine. */
  guided: boolean
  createdAt: string
  updatedAt: string
}

export interface ClarifyMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  round: number
  createdAt: string
}

/** The step awaiting the author's decision in guided mode, with its live content and refine chat. */
export interface GuidedPending {
  stepKey: string
  stage: Stage
  kind: ArtifactKind
  chapter: number | null
  content: string
  /** Human label, e.g. "Chapter 7 — prose" or "World bible". */
  label: string
  messages: { role: 'user' | 'assistant'; content: string }[]
}

export interface CostSummary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  calls: number
}

export interface ModelSettings {
  plannerModel: string
  drafterModel: string
}

export const DEFAULT_MODELS: ModelSettings = {
  plannerModel: 'claude-opus-4-8',
  drafterModel: 'claude-sonnet-5'
}

export type TextProvider = 'api' | 'claude-code'

export interface AppSettings extends ModelSettings {
  /** 'api' = Anthropic API (per-token); 'claude-code' = local Claude Code subscription. */
  textProvider: TextProvider
  anthropicKeySet: boolean
  openaiKeySet: boolean
  /** Author name written into exported books (first/last in FB2). */
  authorName: string
}

/** Spoiler-safe artifact listing for the author's room (content only after unlock). */
export interface ArtifactMeta {
  id: string
  kind: ArtifactKind
  chapter: number | null
  version: number
  createdAt: string
}

export interface ReviewIssueStats {
  round: number
  total: number
  byCategory: Record<string, number>
  bySeverity: Record<string, number>
  open: number
}

export const WORDS_PER_CHAPTER = 3000
export const MIN_CHAPTERS = 8
export const MAX_CHAPTERS = 60

export function deriveChapterCount(targetWords: number): number {
  return Math.max(MIN_CHAPTERS, Math.min(MAX_CHAPTERS, Math.round(targetWords / WORDS_PER_CHAPTER)))
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
