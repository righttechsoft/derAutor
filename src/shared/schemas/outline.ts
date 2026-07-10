import { z } from 'zod'

export const OutlineChapterSchema = z.object({
  index: z.number().int().min(1),
  title: z.string().describe('Chapter title in the book language.'),
  goal: z.string().describe('What this chapter accomplishes in the story.'),
  beats: z.array(z.string()).describe('One-line story beats.'),
  targetWords: z.number().int().min(500)
})
export type OutlineChapter = z.infer<typeof OutlineChapterSchema>

export const OutlineSchema = z.object({
  bookTitle: z.string().describe('Final book title in the book language.'),
  acts: z.array(
    z.object({
      title: z.string(),
      summary: z.string()
    })
  ),
  twistMap: z
    .array(
      z.object({
        description: z.string(),
        setupChapter: z.number().int(),
        payoffChapter: z.number().int()
      })
    )
    .describe('Every planted twist: where it is set up and where it pays off.'),
  chapters: z.array(OutlineChapterSchema).min(1)
})
export type Outline = z.infer<typeof OutlineSchema>
