import { z } from 'zod'

export const DisclosureLevelSchema = z.enum(['DISCLOSED', 'IMPLIED', 'HIDDEN'])
export type DisclosureLevel = z.infer<typeof DisclosureLevelSchema>

export const ChapterPlanSchema = z.object({
  chapter: z.number().int().min(1),
  povCharacter: z.string(),
  scenes: z.array(
    z.object({
      beat: z.string().describe('What happens in this scene.'),
      location: z.string(),
      environmentChanges: z
        .array(z.string())
        .describe('World/environment changes in this scene, consistent with world rules.'),
      innerThoughts: z.array(
        z.object({
          character: z.string(),
          thought: z.string().describe('What this character actually thinks/feels here.')
        })
      )
    })
  ),
  hiddenWorldEvents: z
    .array(z.string())
    .describe('Off-page events happening simultaneously that affect later chapters.'),
  disclosure: z
    .array(
      z.object({
        fact: z.string(),
        level: DisclosureLevelSchema
      })
    )
    .describe(
      'Disclosure table: DISCLOSED facts are stated in prose; IMPLIED facts only shown via action/subtext; HIDDEN facts must never surface in this chapter.'
    )
})
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>
