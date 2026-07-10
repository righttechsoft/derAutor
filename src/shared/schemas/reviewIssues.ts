import { z } from 'zod'

// Deliberately strings, not enums: on very long issue lists the model
// occasionally emits an off-list value, and a strict enum throws away the
// whole (expensive) response over one field. Values are normalized on save.
export const ISSUE_SEVERITIES = ['minor', 'major', 'critical'] as const
export const ISSUE_CATEGORIES = ['continuity', 'logic', 'pacing', 'voice', 'boring'] as const

export const ReviewIssueSchema = z.object({
  chapter: z.number().int().min(1),
  severity: z.string().describe('One of: minor, major, critical.'),
  category: z.string().describe('One of: continuity, logic, pacing, voice, boring.'),
  description: z.string().describe('What exactly is wrong, with chapter-internal references.'),
  fixInstruction: z.string().describe('Concrete instruction for the rewrite pass.')
})
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>

export const ReviewIssuesOutputSchema = z.object({
  issues: z.array(ReviewIssueSchema),
  overallVerdict: z.string().describe('One-paragraph editorial verdict on the whole book.')
})
export type ReviewIssuesOutput = z.infer<typeof ReviewIssuesOutputSchema>
