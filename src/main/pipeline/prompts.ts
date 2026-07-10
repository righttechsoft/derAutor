import type { OutlineChapter } from '@shared/schemas/outline'

/**
 * All prompt builders. Pure functions of their inputs — no timestamps, no IDs —
 * so rendered prompts are byte-stable for prompt caching and step hashing.
 * Bump PROMPT_VERSION when changing any template: it participates in every
 * job input_hash, so completed steps re-run after a template change.
 *
 * Phrases the mock provider keys on (keep intact):
 *   "exactly N chapters", "approximately N words per chapter",
 *   "approximately N words", "chapter N", "review round N".
 */
export const PROMPT_VERSION = 1

export const ICEBERG_RULE = `Iceberg rule: the disclosure table of the chapter plan is binding.
- DISCLOSED facts may be stated openly.
- IMPLIED facts must never be stated; show them only through action, detail, and subtext so an attentive reader can infer them.
- HIDDEN facts must leave no trace in the text of this chapter.
The reader should sense that more is happening than is said.`

export function clarifySystem(input: {
  language: string
  genreHint: string
  targetWords: number
  worldInput: string
  premiseInput: string
}): string {
  return `You are derAutor, a world-building editor preparing to ghost-write a book. The author has given you a world description and a starting premise. Your job in this conversation is an interview: probe the logic, believability and internal consistency of the world and premise until they are solid enough to write from.

Rules:
- Interview only. NEVER propose plot developments, twists, endings, or reveal anything about how you might develop the story. No spoilers of any kind.
- Ask focused questions (at most 3-4 per turn) about gaps, contradictions, unclear rules, stakes, and tone.
- When the author answers, acknowledge briefly and move to the next most important gap.
- Set ready=true as soon as the world and premise are logical, believable and consistent enough — do not drag the interview out.
- Converse in the language the author writes in.
- Channel discipline: all analysis, deliberation and drafting go into the "scratchpad" field. The "message" field contains ONLY the finished reply the author will read — clean prose in their language, plain-text line breaks, no HTML, no notes-to-self, no meta-commentary.

Book configuration: language "${input.language}", genre hint "${input.genreHint}", target length approximately ${input.targetWords} words.

WORLD DESCRIPTION:
${input.worldInput}

STARTING PREMISE:
${input.premiseInput}`
}

export function clarifySequelSystem(input: {
  language: string
  genreHint: string
  targetWords: number
  sourceBookTitle: string
  whatsNew: string
  premiseInput: string
}): string {
  return `You are derAutor, a world-building editor preparing to ghost-write a book set in an ALREADY ESTABLISHED world: the world of the finished book "${input.sourceBookTitle}". Its world bible and the ledger of events established during that book are in your context — they are settled canon. Entries marked as superseding override earlier ones; the world's current state is the state AFTER that book. Your job in this conversation is an interview about the NEW story only: probe the logic, believability and consistency of the new premise and of anything the author says has changed.

Rules:
- Interview only. NEVER propose plot developments, twists, endings, or reveal anything about how you might develop the story. No spoilers of any kind.
- Do not re-interrogate world basics that the canon already answers — build on them.
- NEVER reveal or hint at world-bible lore that was not disclosed in the previous book's text. The ledger and chapter events are reader-visible; the deeper bible lore is not.
- Ask focused questions (at most 3-4 per turn) about gaps, contradictions, unclear rules, stakes, and tone of the NEW story.
- When the author answers, acknowledge briefly and move to the next most important gap.
- Set ready=true as soon as the new premise sits consistently in the established world — do not drag the interview out.
- Converse in the language the author writes in.
- Channel discipline: all analysis, deliberation and drafting go into the "scratchpad" field. The "message" field contains ONLY the finished reply the author will read — clean prose in their language, plain-text line breaks, no HTML, no notes-to-self, no meta-commentary.

Book configuration: language "${input.language}", genre hint "${input.genreHint}", target length approximately ${input.targetWords} words.

AUTHOR'S NOTES — WHAT'S NEW OR CHANGED:
${input.whatsNew || '(none)'}

STARTING PREMISE OF THE NEW BOOK:
${input.premiseInput}`
}

export function clarifyBriefUser(): string {
  return `Consolidate everything established in this interview into a structured brief for the writing team: world facts and rules, refinements to the premise, hard constraints, and the agreed tone. Include only what was established or clearly implied by the author's input and answers.`
}

export function worldBibleUser(brief: string): string {
  return `Using the author's world description, premise and the clarification brief below, write the definitive WORLD BIBLE in markdown. It must cover: fundamental rules of the world (physics/magic/technology and their limits and costs), factions and power structures, geography and key locations, economy and daily life, history relevant to the story, and tone. Resolve any remaining small inconsistencies yourself, choosing the most interesting consistent option. Be concrete and specific — this document is the single source of truth for a whole novel. Do not plot the story here.

CLARIFICATION BRIEF:
${brief}`
}

export function worldBibleUpdateUser(input: { brief: string; summariesText: string }): string {
  return `The context contains the world bible of the previous book and the ledger of world events established during it. Rewrite the definitive WORLD BIBLE in markdown so it describes the world AS IT STANDS AFTER that book: fold every still-true fact — deaths, political shifts, changed or destroyed locations, revealed rules, new power balances — directly into the text. Superseding ledger entries win over earlier ones. This document must stand alone as the single source of truth for the new novel: a reader of this bible alone must know the world's current state without the previous book. Keep the same coverage as a full world bible (fundamental rules and their limits and costs, factions and power structures, geography and key locations, economy and daily life, relevant history — including the events of the previous book, and tone), and incorporate the author's notes about what is new or changed and the clarification brief below. Do not plot the new story here.

CLARIFICATION BRIEF:
${input.brief}

WHAT HAPPENED IN THE PREVIOUS BOOK (chapter summaries as written):
${input.summariesText || '(no summaries available)'}`
}

export function charactersUser(): string {
  return `Create the character sheets for this book: every major character and important secondary character (typically 4-8 total). For each: personality with contradictions, how they think, an inner-monologue voice sample in the book language, a behavior model (under pressure, in conflict, when lying, when afraid, when winning), their secrets and who they hide them from, their arc across the book, and a canonical visual description for illustrations (stable wording).`
}

export function charactersSequelUser(input: { seedCharactersJson: string }): string {
  return `Create the character sheets for this book: every major character and important secondary character (typically 4-8 total). For each: personality with contradictions, how they think, an inner-monologue voice sample in the book language, a behavior model (under pressure, in conflict, when lying, when afraid, when winning), their secrets and who they hide them from, their arc across the book, and a canonical visual description for illustrations (stable wording).

This book continues an established world. The character sheets from the previous book are below. Carry over every returning character, preserving their canonical visual description VERBATIM (unless the story explicitly changed their appearance) so illustrations stay consistent across books; update their state, relationships, secrets and arc to the reality after the previous book (deaths and other superseding ledger facts are binding). Drop characters who cannot appear in this book, and create new sheets for new characters.

CHARACTER SHEETS FROM THE PREVIOUS BOOK:
${input.seedCharactersJson}`
}

export function outlineUser(input: {
  chapterCount: number
  wordsPerChapter: number
  targetWords: number
}): string {
  return `Design the complete story backbone: the main storyline from the given premise to a satisfying ending, in exactly ${input.chapterCount} chapters of approximately ${input.wordsPerChapter} words per chapter (approximately ${input.targetWords} words total).

Requirements:
- A strong dramatic arc across acts; escalating stakes; a payoff for everything set up.
- A twist map: every planted twist with its setup chapter and payoff chapter.
- Per chapter: a title in the book language, the chapter's goal, and one-line beats.
- Chapter indexes run 1..${input.chapterCount}.
- Also decide the final book title in the book language.`
}

export function styleGuideUser(input: { language: string; style?: string }): string {
  const base = `Write the STYLE GUIDE for the prose of this book, written itself in the book language ("${input.language}"): narrative voice and point-of-view discipline, tense, register, sentence rhythm, dialogue conventions (including how dialogue is punctuated in this language), how inner thoughts are rendered, imagery preferences matching the world's tone, and 3 short example paragraphs demonstrating the voice. The final prose must feel literary and alive, never generic.`
  const style = input.style?.trim()
  if (!style) return base // byte-identical to the original — keeps existing step hashes stable
  return `${base}

AUTHOR'S STYLE DIRECTION — treat as binding for the whole book (fold it into the voice, register and rules above, and honor any hard constraints exactly):
${style}`
}

export function chapterPlanUser(input: {
  chapter: number
  outlineRow: OutlineChapter
  priorSummaries: string
  ledger: string
  prevPlanJson: string | null
}): string {
  return `Create the detailed ENHANCED STORYLINE for chapter ${input.chapter}. This is the hidden layer beneath the prose: everything that truly happens, including what will never be told to the reader directly.

Outline row for this chapter:
${JSON.stringify(input.outlineRow, null, 2)}

What actually happened so far (summaries of previous chapters as written):
${input.priorSummaries || '(this is the first chapter)'}

Continuity ledger (established facts that must not be contradicted):
${input.ledger || '(empty)'}

${input.prevPlanJson ? `Plan of the previous chapter:\n${input.prevPlanJson}` : ''}

Requirements:
- Scene-by-scene beats with locations and environment changes that follow the world rules.
- Every present character's real inner thoughts and motives in each scene.
- Hidden world events happening off-page that will matter later.
- A disclosure table classifying every significant fact of this chapter as DISCLOSED, IMPLIED, or HIDDEN. Twists from the outline's twist map must be set up here as IMPLIED or HIDDEN, never DISCLOSED early.`
}

export function chapterProseUser(input: {
  chapter: number
  targetWords: number
  planJson: string
  priorSummaries: string
  ledger: string
  prevTail: string | null
}): string {
  return `Write the final reader prose of chapter ${input.chapter}, approximately ${input.targetWords} words (stay within ±20%). Write in the book language, following the style guide exactly.

The chapter plan (your hidden blueprint — the reader never sees it):
${input.planJson}

What the reader has already read (summaries):
${input.priorSummaries || '(this is the first chapter)'}

Continuity ledger:
${input.ledger || '(empty)'}

${input.prevTail ? `The closing lines of the previous chapter (match the voice seamlessly):\n${input.prevTail}` : ''}

${ICEBERG_RULE}

Output format: plain prose paragraphs separated by blank lines. You may use *emphasis* sparingly. No headings, no chapter title, no markdown beyond that, no notes or commentary — only the chapter text.`
}

export function summaryLedgerUser(input: { chapter: number; proseText: string }): string {
  return `Summarize chapter ${input.chapter} AS WRITTEN below (not as planned), and extract continuity ledger updates: concrete facts future chapters must not contradict (names, dates, injuries, objects, locations, relationships, who-knows-what).

CHAPTER TEXT:
${input.proseText}`
}

export function reviewReadUser(input: {
  round: number
  bookText: string
  outlineJson: string
}): string {
  return `You are the ruthless structural editor performing review round ${input.round}. Read the ENTIRE book below and find every problem: continuity errors, logical contradictions with the world rules or the ledger of established facts, pacing problems, boring or redundant passages, voice inconsistencies, twists that are telegraphed too early or paid off without setup.

Report every issue you find, including ones you are uncertain about — coverage over confidence. For each: the chapter, severity, category, a precise description, and a concrete fix instruction for the rewrite pass.

THE OUTLINE (for intended structure and twist map):
${input.outlineJson}

THE COMPLETE BOOK:
${input.bookText}`
}

export function chapterRewriteUser(input: {
  chapter: number
  currentText: string
  planJson: string
  issues: string
  neighborSummaries: string
}): string {
  return `Rewrite chapter ${input.chapter} to fix the editorial issues listed below. Preserve everything that works; change only what the issues require plus whatever is needed to keep the chapter coherent. Keep the same approximate length, the same voice, and the chapter plan's disclosure table (${'DISCLOSED/IMPLIED/HIDDEN'} discipline stays binding).

CURRENT CHAPTER TEXT:
${input.currentText}

CHAPTER PLAN:
${input.planJson}

ISSUES TO FIX:
${input.issues}

NEIGHBORING CHAPTERS (summaries, for seams):
${input.neighborSummaries}

Output format: plain prose paragraphs separated by blank lines, *emphasis* allowed sparingly, nothing else.`
}

export function imageStyleBlockUser(genreHint: string): string {
  return `Define the single locked illustration style for this entire book (genre hint: "${genreHint}"), based on the world's tone. One art direction that every illustration will share: medium, palette with 2-3 hex anchors, lighting, linework/rendering, era/mood keywords. It must end with: no text, no watermark, no frames.`
}

export function imagePromptUser(input: {
  target: 'cover' | 'chapter'
  chapter: number | null
  readerText: string
  characterVisuals: string
}): string {
  const what =
    input.target === 'cover'
      ? 'the book COVER: an evocative image capturing the book’s atmosphere and setting from its opening — no late-book events, characters or objects the reader has not met at the start'
      : `an illustration for chapter ${input.chapter}: one visually strong moment that the reader has already read in this chapter`
  return `Create an image-generation prompt for ${what}.

Base it ONLY on the reader-visible text below — never depict or hint at anything not yet revealed to the reader at this point. Do not include the art style (it is added separately). Describe the scene, characters present (using their canonical appearance below), composition and mood.

CANONICAL CHARACTER APPEARANCES:
${input.characterVisuals}

READER-VISIBLE TEXT:
${input.readerText}`
}

export function bookMetaUser(input: {
  title: string
  genreHint: string
  firstChapterText: string
}): string {
  return `Produce the publishing metadata for the finished book "${input.title}" (genre hint: "${input.genreHint}").
- A spoiler-free back-cover annotation in the book language, built only from the setup (the first chapter is below for reference).
- The FB2 genre taxonomy code that fits best (e.g. sf, sf_fantasy, detective, thriller, prose_contemporary, love_contemporary, adv_history, child_tale).
- A fitting author pen name.

FIRST CHAPTER (for reference):
${input.firstChapterText}`
}

// --- Translation pipeline ---

/** System persona for every translation call: a literary translator, not a rewriter. */
export function translationSystem(input: { sourceLanguage: string; targetLanguage: string }): string {
  return `You are derAutor, a master literary translator rendering a finished novel from "${input.sourceLanguage}" into "${input.targetLanguage}". You translate faithfully: you preserve meaning, voice, register, rhythm, imagery and the author's disclosure discipline (what the text reveals vs. only implies). You never summarize, abridge, censor, add, or explain — the translated text says exactly what the original says, no more and no less, reading as though it had been written in "${input.targetLanguage}" by the same author. You apply the agreed glossary for every proper noun and invented term.`
}

export function translationGlossaryUser(input: {
  sourceLanguage: string
  targetLanguage: string
  worldBible: string
  charactersJson: string
}): string {
  return `Build the TRANSLATION GLOSSARY for rendering this book from "${input.sourceLanguage}" into "${input.targetLanguage}". List every element that must be rendered consistently across the whole book: character names, place names, invented terms, titles/ranks, organizations, and recurring signature phrases. For each, give the source form, the agreed target form (keep names untranslated where that is the natural choice; adapt where the target language demands it), and a short note (gender, declension, pronunciation, why kept or adapted). Also give overall guidance: register and tone to hold, honorifics, how dialogue punctuation differs between these languages, and pitfalls specific to this language pair.

WORLD BIBLE (source of proper nouns and invented terms):
${input.worldBible}

CHARACTER SHEETS (JSON — source of character names):
${input.charactersJson}`
}

export function translationFrontMatterUser(input: {
  chapterCount: number
  bookTitle: string
  chapterTitlesText: string
  annotation: string
}): string {
  return `Translate the book's front matter into the target language, applying the glossary. There are exactly ${input.chapterCount} chapters. Provide: the translated book title, a translated title for each of the ${input.chapterCount} chapters (keep the same indexes), and the translated back-cover annotation.

ORIGINAL BOOK TITLE:
${input.bookTitle}

ORIGINAL CHAPTER TITLES (index: title):
${input.chapterTitlesText}

ORIGINAL BACK-COVER ANNOTATION:
${input.annotation || '(none)'}`
}

export function translationChapterUser(input: {
  chapter: number
  approxWords: number
  sourceText: string
  prevTargetTail: string | null
}): string {
  return `Translate chapter ${input.chapter} in full into the target language (approximately ${input.approxWords} words — translation length tracks the source, do not pad or trim). Apply the glossary for every proper noun and invented term. Preserve paragraph structure, dialogue, emphasis (*like this*), and the exact disclosure discipline of the original — reveal nothing the source withholds and withhold nothing the source reveals.

${input.prevTargetTail ? `The closing lines of your PREVIOUS translated chapter (match voice and terminology seamlessly):\n${input.prevTargetTail}\n\n` : ''}SOURCE CHAPTER ${input.chapter}:
${input.sourceText}

Output only the translated chapter text: plain prose paragraphs separated by blank lines, *emphasis* preserved where the source has it, no title, no notes.`
}

export function translationCheckReadUser(input: {
  round: number
  bookText: string
  glossary: string
}): string {
  return `You are a bilingual translation editor performing review round ${input.round}. Read the translated book below and find every translation problem: mistranslations and shifts in meaning, proper nouns or invented terms rendered inconsistently with the glossary, passages that are missing or added relative to a faithful translation, wrong register or tone, unidiomatic phrasing, and dialogue-punctuation errors for the target language.

Report every issue you find, including ones you are uncertain about — coverage over confidence. For each: the chapter, severity, category, a precise description, and a concrete fix instruction for the re-translation pass.

TRANSLATION GLOSSARY (the agreed renderings):
${input.glossary}

THE COMPLETE TRANSLATED BOOK:
${input.bookText}`
}

// --- Guided (co-writing) mode: interactive per-step refinement ---

/** Prose refine turn: revise the current artifact per the author's instruction, keeping it consistent. */
export function guidedReviseProseUser(input: {
  label: string
  currentText: string
  message: string
  earlierRequests: string
  extraContext?: string
}): string {
  return `You are co-writing with the author. Revise the ${input.label} below to satisfy the author's request, keeping everything that already works and staying consistent with the world, characters, outline and style in your context.

${input.extraContext ? `${input.extraContext}\n\n` : ''}CURRENT ${input.label.toUpperCase()}:
${input.currentText}
${input.earlierRequests ? `\nEARLIER REQUESTS THIS SESSION:\n${input.earlierRequests}` : ''}

THE AUTHOR'S REQUEST:
${input.message}

Output only the full revised ${input.label} as plain prose (paragraphs separated by blank lines, *emphasis* allowed) — no preamble, no notes.`
}

/** Structured refine turn: produce the full revised artifact JSON conforming to the same schema. */
export function guidedReviseStructuredUser(input: {
  label: string
  currentJson: string
  message: string
  earlierRequests: string
}): string {
  return `You are co-writing with the author. Revise the ${input.label} below to satisfy the author's request, keeping everything that already works and staying consistent with your context. Return the COMPLETE revised ${input.label} in the same structure.

CURRENT ${input.label.toUpperCase()} (JSON):
${input.currentJson}
${input.earlierRequests ? `\nEARLIER REQUESTS THIS SESSION:\n${input.earlierRequests}` : ''}

THE AUTHOR'S REQUEST:
${input.message}`
}

// --- Interactive edit chat (post-finish patching of an edit variant) ---

/** Streamed conversational reply describing the change being made, not the change itself. */
export function editChatReplyUser(input: { message: string; scope: string }): string {
  return `You are chatting with the author who is editing their finished book, specifically ${input.scope}. Reply in 1-3 plain-prose sentences describing the change you're about to make in response to their request below. Do not restate the full new text — just tell them what you're doing.

THE AUTHOR'S REQUEST:
${input.message}`
}

/** Structured call for anchored find/replace ops against one or more chapters' current text. */
export function editOpsUser(input: {
  instruction: string
  chapters: { chapter: number; content: string }[]
}): string {
  const blocks = input.chapters.map((c) => `=== CHAPTER ${c.chapter} ===\n${c.content}`).join('\n\n')
  return `The author wants this change applied to their finished book: "${input.instruction}"

Return anchored find/replace ops that make the change. For each op: "find" must be an EXACT verbatim substring copied from the chapter text below — long enough to be unique within that chapter (a full sentence or clause, never just a word or two) — "replace" is the new text to put in its place, and "chapter" is the chapter number it targets. Only include ops for chapters that actually need a change.

CHAPTERS:
${blocks}`
}

/** Structured call (later phase): anchored ops on OTHER chapters that resolve contradictions an edit caused. */
export function continuityAlignUser(input: {
  editedChapter: number
  editedSummary: string
  otherSummaries: string
  ledger: string
}): string {
  return `Chapter ${input.editedChapter} of this finished book was just edited. Check whether the edit contradicts anything established in the rest of the book, and if so, return anchored find/replace ops on the OTHER chapters that resolve the contradictions. Never creatively rewrite untouched chapters — only patch what the edit to chapter ${input.editedChapter} broke.

CHAPTER ${input.editedChapter} AS EDITED (new summary):
${input.editedSummary}

SUMMARIES OF THE OTHER CHAPTERS:
${input.otherSummaries}

CONTINUITY LEDGER (established facts):
${input.ledger}`
}

export function translationRetranslateUser(input: {
  chapter: number
  approxWords: number
  sourceText: string
  currentText: string
  issues: string
}): string {
  return `Re-translate chapter ${input.chapter} into the target language (approximately ${input.approxWords} words), fixing the editorial issues listed below while keeping everything that already reads well. Apply the glossary. Preserve the source's meaning and disclosure discipline exactly.

SOURCE CHAPTER ${input.chapter} (the ground truth):
${input.sourceText}

CURRENT TRANSLATION (to improve):
${input.currentText}

ISSUES TO FIX:
${input.issues}

Output only the corrected translated chapter text: plain prose paragraphs separated by blank lines, *emphasis* preserved, no title, no notes.`
}
