import type { NewProjectInput } from '@shared/domain'
import { inTransaction } from '../db/database'
import { copyCurrentArtifacts } from '../db/repo/artifacts'
import { copyImages } from '../db/repo/images'
import type { ProjectRow } from '../db/repo/projects'
import { createProject, getProjectRow, updateProject } from '../db/repo/projects'

/**
 * Edit variant: a named clone of a FINISHED language book that the user edits
 * freely — the original stays frozen. Modeled on createProjectTranslation: one
 * transaction clones the project row, current artifacts, and images, so a
 * failure leaves nothing half-created. Unlike a translation there is no seed
 * artifact — edits work directly on the copied chapter prose. Variants clone
 * from the language book only (not from another variant), so
 * `source_project_id` always points at a non-edit-copy project.
 */
export function createProjectEditVariant(sourceProjectId: string, label: string): ProjectRow {
  return inTransaction(() => {
    const source = getProjectRow(sourceProjectId)
    if (source.stage !== 'done') {
      throw new Error(`"${source.title}" is not finished yet — only finished books can be edited.`)
    }
    if (source.edit_copy !== 0) {
      throw new Error('Cannot create an edit variant of an edit variant — start from the finished book.')
    }
    const input: NewProjectInput = {
      title: source.title,
      language: source.language,
      targetWords: source.target_words,
      illustrations: !!source.illustrations,
      genreHint: source.genre_hint,
      worldInput: source.world_input,
      premiseInput: source.premise_input,
      styleInput: source.style_input,
      sourceProjectId
    }
    const row = createProject(input)
    // world_seed/translation_seed describe HOW the source book was built, not the
    // edit variant — carrying them over would make the clone falsely report isTranslation.
    copyCurrentArtifacts(sourceProjectId, row.id, { exclude: ['translation_seed', 'world_seed'] })
    copyImages(sourceProjectId, row.id)
    updateProject(row.id, {
      stage: 'done',
      status: 'idle',
      chapter_count: source.chapter_count,
      review_round: 0,
      authors_room_unlocked: 1,
      edit_copy: 1,
      edit_label: label
    })
    return getProjectRow(row.id)
  })
}
