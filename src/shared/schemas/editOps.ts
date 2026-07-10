import { z } from 'zod'

export const EditOpSchema = z.object({
  chapter: z.number().int().describe('The chapter number this op targets.'),
  find: z.string().describe('Exact verbatim substring to locate in the chapter text (the anchor).'),
  replace: z.string().describe('Text to put in place of the anchor.'),
  reason: z.string().optional().describe('Short note on why this change was made.')
})
export type EditOpValue = z.infer<typeof EditOpSchema>

export const EditOpsOutputSchema = z.object({
  ops: z.array(EditOpSchema)
})
export type EditOpsOutput = z.infer<typeof EditOpsOutputSchema>

/** Used by the proofread/align stage (a later phase) to patch OTHER chapters after an edit. */
export const ContinuityConflictsSchema = z.object({
  conflicts: z.array(EditOpSchema)
})
export type ContinuityConflicts = z.infer<typeof ContinuityConflictsSchema>
