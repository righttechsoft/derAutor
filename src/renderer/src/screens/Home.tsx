import React, { useEffect, useMemo, useState } from 'react'
import type { ProjectSummary } from '@shared/domain'
import { useStore } from '../store'
import { groupBooks, type BookGroup } from '../books'
import { fmtCost, fmtDate, fmtInt, pct } from '../format'
import { StageBadge, StatusBadge } from '../components/Badges'
import { ConfirmDialog, Modal } from '../components/Modal'
import { BookIcon, GearIcon, PlusIcon } from '../components/Icons'

function variantStatusText(v: ProjectSummary): string {
  if (v.stage === 'done' || v.status === 'done') return 'done'
  if (v.status === 'running') return `${pct(v.wordsWritten, v.targetWords)}%`
  return v.status
}

/** Per-language action sheet opened from a chip. */
function VariantMenu({
  variant,
  onClose,
  onOpen,
  onDownload,
  onAuthorsRoom,
  onEdit,
  onDelete
}: {
  variant: ProjectSummary
  onClose: () => void
  onOpen: () => void
  onDownload: () => void
  onAuthorsRoom: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const done = variant.stage === 'done' || variant.status === 'done'
  return (
    <Modal title={`${variant.title || 'Untitled'} — ${variant.language}`} onClose={onClose}>
      <div className="variant-actions">
        <button className="btn btn-primary" onClick={onOpen}>
          Open
        </button>
        <button className="btn btn-ghost" onClick={onDownload} disabled={!done} title={done ? undefined : 'Finish this language first'}>
          Download FB2…
        </button>
        <button className="btn btn-ghost" onClick={onAuthorsRoom} disabled={!done}>
          Author’s Room
        </button>
        <button className="btn btn-ghost" onClick={onEdit} disabled={!done} title={done ? undefined : 'Finish this language first'}>
          Edit
        </button>
        <button className="btn btn-danger" onClick={onDelete}>
          Delete this language
        </button>
      </div>
    </Modal>
  )
}

/** Opened from VariantMenu's Edit button: lists/creates/opens named edit variants of one language book. */
function EditVariantsPicker({ book, onClose }: { book: ProjectSummary; onClose: () => void }): React.JSX.Element {
  const variants = useStore((s) => s.editVariants)
  const listEditVariants = useStore((s) => s.listEditVariants)
  const createEditVariant = useStore((s) => s.createEditVariant)
  const renameEditVariant = useStore((s) => s.renameEditVariant)
  const deleteEditVariant = useStore((s) => s.deleteEditVariant)
  const openEditVariant = useStore((s) => s.openEditVariant)

  const [newLabel, setNewLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [renameLabel, setRenameLabel] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null)

  useEffect(() => {
    void listEditVariants(book.id)
  }, [book.id, listEditVariants])

  async function open(v: ProjectSummary): Promise<void> {
    await openEditVariant(v.id)
    onClose()
  }

  async function create(): Promise<void> {
    const label = newLabel.trim()
    if (!label || creating) return
    setCreating(true)
    try {
      const variant = await createEditVariant(book.id, label)
      await open(variant)
    } finally {
      setCreating(false)
    }
  }

  async function saveRename(): Promise<void> {
    if (!renaming) return
    const label = renameLabel.trim()
    if (!label) return
    await renameEditVariant(renaming.id, label)
    setRenaming(null)
  }

  return (
    <>
      <Modal title={`Edit — ${book.title || 'Untitled'} (${book.language})`} onClose={onClose}>
        <div className="variant-list">
          {variants.length === 0 && <p className="muted">No edit variants yet.</p>}
          {variants.map((v) =>
            renaming?.id === v.id ? (
              <div key={v.id} className="variant-row">
                <input
                  className="input"
                  value={renameLabel}
                  autoFocus
                  onChange={(e) => setRenameLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
                <span className="variant-row-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => void saveRename()}>
                    Save
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </span>
              </div>
            ) : (
              <div key={v.id} className="variant-row">
                <span className="variant-row-lang">{v.editLabel || 'Untitled variant'}</span>
                <span className="muted variant-row-status">Updated {fmtDate(v.updatedAt)}</span>
                <span className="variant-row-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => void open(v)}>
                    Open
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setRenaming(v)
                      setRenameLabel(v.editLabel ?? '')
                    }}
                  >
                    Rename
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPendingDelete(v)}>
                    Delete
                  </button>
                </span>
              </div>
            )
          )}
        </div>

        <div className="translate-row">
          <label className="field">
            <span className="field-label">New variant name</span>
            <input
              className="input"
              value={newLabel}
              placeholder="e.g. Reader-friendly pass"
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
            />
          </label>
          <button className="btn btn-primary" onClick={() => void create()} disabled={creating || !newLabel.trim()}>
            {creating ? 'Creating…' : 'New variant'}
          </button>
        </div>
      </Modal>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this edit variant?"
          message={
            <p>
              <strong>{pendingDelete.editLabel || 'Untitled variant'}</strong> will be permanently
              removed. This cannot be undone.
            </p>
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void deleteEditVariant(pendingDelete.id, book.id)
            setPendingDelete(null)
          }}
        />
      )}
    </>
  )
}

function BookCard({
  group,
  cost,
  onOpenVariant,
  onMenu
}: {
  group: BookGroup
  cost: number
  onOpenVariant: (v: ProjectSummary) => void
  onMenu: (v: ProjectSummary) => void
}): React.JSX.Element {
  const { root, variants } = group
  const percent = pct(root.wordsWritten, root.targetWords)
  const cover = useStore((s) => s.covers[root.id])
  const loadCover = useStore((s) => s.loadCover)
  useEffect(() => {
    void loadCover(root.id)
  }, [root.id, loadCover])

  const done = root.stage === 'done' || root.status === 'done'
  return (
    <div
      className={`book-card ${cover ? 'has-cover' : 'no-cover'}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpenVariant(root)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpenVariant(root)
      }}
    >
      {cover ? (
        <img className="book-card-cover" src={cover} alt="" />
      ) : (
        <div className="book-card-watermark">
          <BookIcon size={72} />
        </div>
      )}
      <div className="book-card-scrim" />

      <div className="book-card-status">
        <StatusBadge status={root.status} />
      </div>

      <div className="book-card-body">
        <div className="book-card-badges">
          {!done && <StageBadge stage={root.stage} />}
          {root.guided && <span className="lang-chip" title="Guided co-writing">✎ Guided</span>}
          {root.sourceTitle && !root.isTranslation && (
            <span className="lang-chip" title="Continues the world of this book">
              ↳ {root.sourceTitle}
            </span>
          )}
        </div>

        <h3 className="book-card-title">{root.bookTitle ?? root.title ?? 'Untitled'}</h3>

        <div className="variant-chips">
          {variants.map((v) => {
            const vDone = v.stage === 'done' || v.status === 'done'
            return (
              <button
                key={v.id}
                className={`variant-chip status-${v.status}`}
                title={`${v.language} — ${v.status}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onMenu(v)
                }}
              >
                <span className="status-dot" />
                {v.language.toUpperCase()}
                {!vDone && <span className="variant-chip-sub"> · {variantStatusText(v)}</span>}
              </button>
            )
          })}
        </div>

        <div className="book-card-progress">
          {!done && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          )}
          <div className="project-card-meta">
            {!done && (
              <>
                <span>{percent}%</span>
                <span className="muted">
                  {fmtInt(root.wordsWritten)} / {fmtInt(root.targetWords)} words
                </span>
              </>
            )}
            <span className="cost-chip">{fmtCost(cost)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Home(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const liveCost = useStore((s) => s.liveCost)
  const openProject = useStore((s) => s.openProject)
  const deleteProject = useStore((s) => s.deleteProject)
  const exportSaveAs = useStore((s) => s.exportSaveAs)
  const loadArtifacts = useStore((s) => s.loadArtifacts)
  const setScreen = useStore((s) => s.setScreen)

  const [menuVariant, setMenuVariant] = useState<ProjectSummary | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null)
  const [editPickerBook, setEditPickerBook] = useState<ProjectSummary | null>(null)

  // Edit variants are reachable only via the Edit → variants picker, never as their own card.
  const groups = useMemo(() => groupBooks(projects.filter((p) => !p.isEditCopy)), [projects])

  async function authorsRoom(v: ProjectSummary): Promise<void> {
    await openProject(v)
    if (v.authorsRoomUnlocked) {
      await loadArtifacts(v.id)
      setScreen('authorsRoom')
    }
  }

  return (
    <div className="screen home">
      <header className="home-header">
        <div className="home-actions">
          <button className="btn btn-ghost btn-icon" aria-label="Settings" onClick={() => setScreen('settings')}>
            <GearIcon />
          </button>
          <button className="btn btn-primary" onClick={() => setScreen('wizard')}>
            <PlusIcon size={16} /> New Book
          </button>
        </div>
      </header>

      {projects.length === 0 ? (
        <div className="empty-state">
          <BookIcon size={40} />
          <h2>No books yet</h2>
          <p className="muted">Start a new book and describe the world you want to explore.</p>
          <button className="btn btn-primary" onClick={() => setScreen('wizard')}>
            <PlusIcon size={16} /> New Book
          </button>
        </div>
      ) : (
        <div className="card-grid">
          {groups.map((g) => (
            <BookCard
              key={g.root.id}
              group={g}
              cost={liveCost[g.root.id] ?? g.root.costUsd}
              onOpenVariant={(v) => void openProject(v)}
              onMenu={(v) => setMenuVariant(v)}
            />
          ))}
        </div>
      )}

      {menuVariant && (
        <VariantMenu
          variant={menuVariant}
          onClose={() => setMenuVariant(null)}
          onOpen={() => {
            const v = menuVariant
            setMenuVariant(null)
            void openProject(v)
          }}
          onDownload={() => {
            const v = menuVariant
            setMenuVariant(null)
            void exportSaveAs(v.id)
          }}
          onAuthorsRoom={() => {
            const v = menuVariant
            setMenuVariant(null)
            void authorsRoom(v)
          }}
          onEdit={() => {
            const v = menuVariant
            setMenuVariant(null)
            setEditPickerBook(v)
          }}
          onDelete={() => {
            setPendingDelete(menuVariant)
            setMenuVariant(null)
          }}
        />
      )}

      {editPickerBook && (
        <EditVariantsPicker book={editPickerBook} onClose={() => setEditPickerBook(null)} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this language?"
          message={
            <p>
              <strong>
                {pendingDelete.title || 'Untitled'} ({pendingDelete.language})
              </strong>{' '}
              will be permanently removed. Other languages of this book stay. This cannot be undone.
            </p>
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void deleteProject(pendingDelete.id)
            setPendingDelete(null)
          }}
        />
      )}
    </div>
  )
}
