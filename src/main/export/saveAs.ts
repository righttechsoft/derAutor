import { dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { getProjectRow } from '../db/repo/projects'
import { buildFb2 } from './fb2'

export async function exportSaveAs(
  projectId: string
): Promise<{ path: string } | { cancelled: true }> {
  const project = getProjectRow(projectId)
  if (project.stage !== 'done') throw new Error('Book is not finished yet')
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Save book',
    defaultPath: `${project.title.replace(/[\\/:*?"<>|]/g, '_')}.fb2`,
    filters: [{ name: 'FictionBook', extensions: ['fb2'] }]
  })
  if (canceled || !filePath) return { cancelled: true }
  const xml = buildFb2(projectId)
  // UTF-8 without BOM per FB2 reader compatibility
  await writeFile(filePath, xml, { encoding: 'utf8' })
  return { path: filePath }
}
