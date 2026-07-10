import { z } from 'zod'

export const CharacterSheetSchema = z.object({
  name: z.string(),
  role: z.string().describe('Narrative role, e.g. protagonist, antagonist, mentor.'),
  personality: z.string().describe('Core personality traits and contradictions.'),
  thinkingStyle: z.string().describe('How this character reasons; what they notice first.'),
  voiceSample: z.string().describe('2-3 sentences of inner monologue in their authentic voice, in the book language.'),
  behaviorModel: z
    .string()
    .describe('How they behave under pressure, in conflict, when lying, when afraid, when winning.'),
  secrets: z.array(z.string()).describe('What they hide and from whom.'),
  arc: z.string().describe('How they change across the book.'),
  visualDescription: z
    .string()
    .describe(
      'Canonical physical appearance for illustrations: build, face, hair, clothing, distinguishing marks. Stable wording, reused verbatim.'
    )
})
export type CharacterSheet = z.infer<typeof CharacterSheetSchema>

export const CharactersOutputSchema = z.object({
  characters: z.array(CharacterSheetSchema).min(1)
})
export type CharactersOutput = z.infer<typeof CharactersOutputSchema>
