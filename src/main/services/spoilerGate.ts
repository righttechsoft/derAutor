import type { ArtifactMeta } from '@shared/domain'
import { getArtifactById, listArtifactMeta } from '../db/repo/artifacts'
import { getProjectRow, updateProject } from '../db/repo/projects'

/**
 * The spoiler boundary. The renderer can NEVER read artifact content unless
 * the book is finished and the user has explicitly unlocked the author's room
 * by typing the project title.
 */

export function unlockAuthorsRoom(projectId: string, confirmTitle: string): boolean {
  const project = getProjectRow(projectId)
  if (project.stage !== 'done') return false
  if (confirmTitle.trim() !== project.title.trim()) return false
  updateProject(projectId, { authors_room_unlocked: 1 })
  return true
}

function assertUnlocked(projectId: string): void {
  const project = getProjectRow(projectId)
  // Guided (co-writing) projects have no spoiler boundary — the author is meant to
  // see everything live, so every artifact/version is readable during the run.
  if (project.guided) return
  if (!project.authors_room_unlocked) {
    throw new Error('Author’s room is locked')
  }
}

export function listUnlockedArtifacts(projectId: string): ArtifactMeta[] {
  assertUnlocked(projectId)
  return listArtifactMeta(projectId)
}

export function readUnlockedArtifact(projectId: string, artifactId: string): string {
  assertUnlocked(projectId)
  const artifact = getArtifactById(projectId, artifactId)
  if (!artifact) throw new Error('Artifact not found')
  return artifact.content
}
