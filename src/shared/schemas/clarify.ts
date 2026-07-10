import { z } from 'zod'

/** One assistant turn of the world-clarification interview. */
export const ClarifyTurnSchema = z.object({
  scratchpad: z
    .string()
    .describe(
      'PRIVATE working notes, never shown to the author: note the key gaps or contradictions and what to ask next. Keep it brief — a few sentences at most. Do all deliberation here, not in message.'
    ),
  message: z
    .string()
    .describe(
      'ONLY the final, polished reply shown to the author — nothing else. Written entirely in the conversation language. Plain text with \\n for line breaks; no HTML tags, no meta-commentary, no drafting notes, no mentions of JSON or formatting. Interview only — never propose plot, twists, or endings.'
    ),
  ready: z
    .boolean()
    .describe('True once the world and premise are logical, believable and consistent enough to start writing.'),
  remainingConcerns: z
    .array(z.string())
    .describe('Open logical gaps or contradictions still unresolved; empty when ready.')
})
export type ClarifyTurn = z.infer<typeof ClarifyTurnSchema>

/** Consolidated digest of everything learned during clarification. */
export const ClarifyBriefSchema = z.object({
  worldFacts: z.array(z.string()).describe('Established world facts and rules, one per entry.'),
  premiseRefinements: z.array(z.string()).describe('Refinements or corrections to the starting premise.'),
  constraints: z.array(z.string()).describe('Hard constraints the story must respect.'),
  tone: z.string().describe('Agreed tone and mood of the book.')
})
export type ClarifyBrief = z.infer<typeof ClarifyBriefSchema>
