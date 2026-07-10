import { ipcMain } from 'electron'
import type { CommandChannel, IpcCommands } from '@shared/ipc-contract'
import {
  deleteProject,
  getProjectRow,
  listEditVariants,
  listProjectRows,
  toSummary,
  updateProject
} from '../db/repo/projects'
import { getChapterArtifacts, getCurrentContent } from '../db/repo/artifacts'
import { createProjectMaybeSeeded } from '../pipeline/worldSeed'
import { createProjectTranslation } from '../pipeline/translationSeed'
import { createProjectEditVariant } from '../pipeline/editVariants'
import { applyOps, applyRename, editChatSafe, undoEdit } from '../pipeline/editBook'
import { fixImage, restyleImagesText } from '../pipeline/editImages'
import { startProofread } from '../pipeline/proofread'
import {
  guidedApprove,
  guidedCurrent,
  guidedEdit,
  guidedRefineSafe,
  guidedRegenerate,
  guidedRunFree
} from '../pipeline/guided'
import { getClarifyHistory } from '../db/repo/clarify'
import { getImage, listImages } from '../db/repo/images'
import { costSummary } from '../db/repo/usage'
import { issueStats } from '../db/repo/issues'
import { getAppSettings, updateSettings } from '../services/settings'
import { listUnlockedArtifacts, readUnlockedArtifact, unlockAuthorsRoom } from '../services/spoilerGate'
import {
  cancelPipeline,
  clarifyProceed,
  clarifySend,
  kickoffClarify,
  pausePipeline,
  startPipeline
} from '../pipeline/controller'
import { exportSaveAs } from '../export/saveAs'

function handle<C extends CommandChannel>(
  channel: C,
  fn: (...args: IpcCommands[C]['args']) => IpcCommands[C]['result'] | Promise<IpcCommands[C]['result']>
): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...(args as IpcCommands[C]['args'])))
}

export function registerIpcHandlers(): void {
  handle('settings:get', () => getAppSettings())
  handle('settings:set', (patch) => updateSettings(patch))

  handle('project:list', () => listProjectRows().map(toSummary))
  handle('project:get', (id) => toSummary(getProjectRow(id)))
  handle('project:create', (input) => {
    if (input.mode === 'translation') {
      // A translation skips the clarify interview and starts at the glossary stage.
      const project = createProjectTranslation(input)
      return toSummary(project)
    }
    const project = createProjectMaybeSeeded(input)
    kickoffClarify(project.id) // the AI opens the world interview
    return toSummary(project)
  })
  handle('project:delete', (id) => {
    cancelPipeline(id)
    deleteProject(id)
  })
  handle('project:start', (id) => startPipeline(id))
  handle('project:setIllustrations', (id, on) => {
    const project = getProjectRow(id)
    updateProject(id, { illustrations: on ? 1 : 0 })
    if (on && (project.stage === 'export' || project.stage === 'done')) {
      // Finished (or exporting) book: go back and paint, then re-export.
      updateProject(id, { stage: 'illustrate', status: 'paused' })
    } else if (!on && project.stage === 'illustrate') {
      updateProject(id, { stage: 'export' })
    }
    return toSummary(getProjectRow(id))
  })
  handle('project:pause', (id) => pausePipeline(id))
  handle('project:cancel', (id) => cancelPipeline(id))
  handle('project:costs', (id) => costSummary(id))
  handle('project:reviewStats', (id) => issueStats(id))
  handle('project:cover', (id) => {
    const img = getImage(id, 'cover')
    if (!img?.jpeg) return null
    return `data:image/jpeg;base64,${Buffer.from(img.jpeg).toString('base64')}`
  })
  // Annotation is spoiler-free by design (BookMetaSchema), so no author's-room unlock needed.
  handle('project:annotation', (id) => {
    const raw = getCurrentContent(id, 'book_meta')
    if (!raw) return null
    try {
      return (JSON.parse(raw) as { annotation?: string }).annotation ?? null
    } catch {
      return null
    }
  })

  handle('clarify:history', (id) => getClarifyHistory(id))
  handle('clarify:send', (id, text) => clarifySend(id, text))
  handle('clarify:proceed', (id) => clarifyProceed(id))

  handle('export:saveAs', (id) => exportSaveAs(id))

  handle('authorsRoom:unlock', (id, confirmTitle) => unlockAuthorsRoom(id, confirmTitle))
  handle('authorsRoom:list', (id) => listUnlockedArtifacts(id))
  handle('authorsRoom:read', (id, artifactId) => readUnlockedArtifact(id, artifactId))

  handle('guided:current', (id) => guidedCurrent(id))
  handle('guided:approve', (id) => guidedApprove(id))
  handle('guided:regenerate', (id) => guidedRegenerate(id))
  handle('guided:edit', (id, content) => guidedEdit(id, content))
  handle('guided:refine', (id, message) => guidedRefineSafe(id, message))
  handle('guided:runFree', (id) => guidedRunFree(id))

  handle('edit:listVariants', (sourceId) => listEditVariants(sourceId).map(toSummary))
  handle('edit:createVariant', (sourceId, label) => toSummary(createProjectEditVariant(sourceId, label)))
  handle('edit:renameVariant', (id, label) => {
    const project = getProjectRow(id)
    if (!project.edit_copy) throw new Error('Not an edit variant')
    updateProject(id, { edit_label: label })
    return toSummary(getProjectRow(id))
  })
  handle('edit:chapters', (id) => {
    const project = getProjectRow(id)
    if (!project.edit_copy) throw new Error('Not an edit variant — edits can never target a finished book directly')
    // ponytail: title should come from the outline artifact, like translationSeed's
    // outlineTitleMap — left blank for now, phase 1 is read-only chapter text.
    return getChapterArtifacts(id, 'chapter_final')
      .filter((a) => a.chapter != null)
      .map((a) => ({ chapter: a.chapter as number, title: '', content: a.content }))
  })
  handle('edit:chapterImages', (id) => {
    const project = getProjectRow(id)
    if (!project.edit_copy) throw new Error('Not an edit variant — edits can never target a finished book directly')
    return listImages(id)
      .filter((img) => img.kind === 'chapter' && img.jpeg)
      .map((img) => ({
        chapter: img.chapter as number,
        dataUrl: `data:image/jpeg;base64,${Buffer.from(img.jpeg as Uint8Array).toString('base64')}`
      }))
  })
  handle('edit:chat', (id, req) => editChatSafe(id, req))
  handle('edit:applyOps', (id, ops) => applyOps(id, ops))
  handle('edit:rename', (id, from, to) => applyRename(id, from, to))
  handle('edit:undo', (id, chapter) => undoEdit(id, chapter))
  handle('edit:fixImage', (id, chapter, instruction) => fixImage(id, chapter, instruction))
  handle('edit:restyleImages', (id, style) => restyleImagesText(id, style))
  handle('edit:proofread', (id, mode) => startProofread(id, mode))
}
