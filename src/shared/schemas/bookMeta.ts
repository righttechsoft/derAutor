import { z } from 'zod'

export const BookMetaSchema = z.object({
  annotation: z
    .string()
    .describe('Spoiler-free back-cover blurb, 2-4 paragraphs, in the book language, built only from the setup.'),
  fb2Genre: z
    .string()
    .describe("FB2 genre taxonomy code, e.g. 'sf_fantasy', 'detective', 'prose_contemporary'."),
  authorPseudonym: z.string().describe('A fitting pen name for this book.')
})
export type BookMeta = z.infer<typeof BookMetaSchema>
