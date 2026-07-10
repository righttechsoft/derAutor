import { z } from 'zod'

export const LedgerFactKindSchema = z.enum([
  'name',
  'date',
  'injury',
  'object',
  'location',
  'relationship',
  'who-knows-what',
  'other'
])

export const SummaryLedgerSchema = z.object({
  summary: z
    .string()
    .describe('300-500 word factual summary of the chapter as written (not as planned).'),
  ledgerUpdates: z.array(
    z.object({
      fact: z.string().describe('A concrete established fact future chapters must not contradict.'),
      kind: LedgerFactKindSchema,
      op: z.enum(['add', 'amend']).describe("'amend' replaces a previously established fact it contradicts.")
    })
  ),
  timeDelta: z.string().describe("In-story time elapsed during this chapter, e.g. '2 days'.")
})
export type SummaryLedger = z.infer<typeof SummaryLedgerSchema>
