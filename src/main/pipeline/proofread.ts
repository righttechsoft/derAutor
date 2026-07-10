import { getProjectRow, updateProject } from '../db/repo/projects'
import { startPipeline } from './controller'

/**
 * Kicks off one of the two proofread passes offered after editing a variant:
 * 'full-review' reuses the whole-book review stage unchanged (fresh — the
 * clone's jobs table is empty); 'align' runs the new targeted alignment stage
 * that only touches what the edits changed. Both flip the stage away from
 * 'done' (startPipeline no-ops on 'done') and run through the checkpointed
 * engine, so a pause/kill mid-pass resumes correctly.
 */
export function startProofread(projectId: string, mode: 'align' | 'full-review'): void {
  const project = getProjectRow(projectId)
  if (project.edit_copy !== 1) throw new Error('Not an edit variant — proofread only runs on edit variants')

  if (mode === 'full-review') {
    updateProject(projectId, { stage: 'review', status: 'paused', review_round: 0 })
  } else {
    updateProject(projectId, { stage: 'align', status: 'paused' })
  }
  startPipeline(projectId)
}
