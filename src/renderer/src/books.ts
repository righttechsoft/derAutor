import type { ProjectSummary } from '@shared/domain'

export interface BookGroup {
  root: ProjectSummary
  /** root first, then its translations, oldest first. */
  variants: ProjectSummary[]
}

/**
 * The original project a variant belongs to. Follows the TRANSLATION link only —
 * a sequel (source set but not a translation) is its own root. Resolves
 * transitively so a translation-of-a-translation lands on the true original.
 */
export function rootOf(projects: ProjectSummary[], p: ProjectSummary): ProjectSummary {
  const byId = new Map(projects.map((x) => [x.id, x]))
  let cur = p
  const seen = new Set<string>()
  while (cur.isTranslation && cur.sourceProjectId && byId.has(cur.sourceProjectId) && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = byId.get(cur.sourceProjectId) as ProjectSummary
  }
  return cur
}

/** Groups projects into books: one original + its translations. */
export function groupBooks(projects: ProjectSummary[]): BookGroup[] {
  const groups = new Map<string, BookGroup>()
  const order: string[] = []
  for (const p of projects) {
    const r = rootOf(projects, p)
    if (!groups.has(r.id)) {
      groups.set(r.id, { root: r, variants: [] })
      order.push(r.id)
    }
    groups.get(r.id)!.variants.push(p)
  }
  for (const g of groups.values()) {
    g.variants.sort((a, b) =>
      a.id === g.root.id ? -1 : b.id === g.root.id ? 1 : a.createdAt.localeCompare(b.createdAt)
    )
  }
  return order.map((id) => groups.get(id) as BookGroup)
}

/** All language variants of the book that `projectId` belongs to (root first). */
export function familyOf(projects: ProjectSummary[], projectId: string): BookGroup | null {
  const p = projects.find((x) => x.id === projectId)
  if (!p) return null
  const root = rootOf(projects, p)
  return groupBooks(projects).find((g) => g.root.id === root.id) ?? null
}
