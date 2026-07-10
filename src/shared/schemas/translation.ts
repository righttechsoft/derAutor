import { z } from 'zod'

/** One proper noun / invented term with its agreed rendering in the target language. */
export const GlossaryTermSchema = z.object({
  source: z.string().describe('The term exactly as it appears in the source language.'),
  target: z.string().describe('The agreed rendering in the target language (may be identical for names kept as-is).'),
  note: z.string().describe('Short guidance: pronunciation, gender, why it is kept or adapted, declension notes.')
})
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>

export const TranslationGlossarySchema = z.object({
  terms: z
    .array(GlossaryTermSchema)
    .describe('Every proper noun, place name, invented term, and recurring phrase that must be rendered consistently.'),
  guidance: z
    .string()
    .describe('Overall translation guidance: register, tone, honorifics, how dialogue punctuation differs, pitfalls between these two languages.')
})
export type TranslationGlossary = z.infer<typeof TranslationGlossarySchema>

/** Translated book-level strings (title, per-chapter titles, back-cover blurb). */
export const TranslationFrontMatterSchema = z.object({
  bookTitle: z.string().describe('The book title translated into the target language.'),
  chapterTitles: z
    .array(
      z.object({
        index: z.number().int().min(1).describe('Chapter index, matching the source outline.'),
        title: z.string().describe('The chapter title translated into the target language.')
      })
    )
    .describe('One entry per chapter, in order.'),
  annotation: z
    .string()
    .describe('The spoiler-free back-cover annotation translated into the target language.')
})
export type TranslationFrontMatter = z.infer<typeof TranslationFrontMatterSchema>
