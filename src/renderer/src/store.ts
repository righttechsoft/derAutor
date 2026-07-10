import { create } from 'zustand'
import type {
  AppSettings,
  ArtifactMeta,
  ClarifyMessage,
  CostSummary,
  GuidedPending,
  NewProjectInput,
  ProjectSummary,
  ReviewIssueStats,
  Stage
} from '@shared/domain'
import type { EventChannel, IpcEvents } from '@shared/ipc-contract'
import type { EditReport } from '@shared/editOps'

const api = window.api

export type Screen =
  | 'home'
  | 'wizard'
  | 'clarify'
  | 'progress'
  | 'guided'
  | 'export'
  | 'authorsRoom'
  | 'settings'
  | 'editBook'

/** Latest spoiler-free progress snapshot for a project, from pipeline:progress. */
export interface LiveProgress {
  stage: Stage
  stepKey: string
  chapter: number | null
  ofChapters: number | null
  wordsWritten: number
  message: string
}

export interface SettingsPatch {
  anthropicKey?: string
  openaiKey?: string
  plannerModel?: string
  drafterModel?: string
  authorName?: string
  textProvider?: 'api' | 'claude-code'
}

interface AppState {
  // navigation
  screen: Screen
  selectedProjectId: string | null

  // core data
  projects: ProjectSummary[]
  settings: AppSettings | null

  // clarify chat (for the selected project)
  clarifyMessages: ClarifyMessage[]
  pendingAssistant: string | null
  clarifyReady: boolean
  clarifyBusy: boolean
  clarifyError: string | null

  // live per-project telemetry
  progress: Record<string, LiveProgress>
  liveCost: Record<string, number>
  errors: Record<string, string | null>
  activity: Record<string, { at: string; line: string }[]>

  // detail data for the selected project
  costSummary: CostSummary | null
  reviewStats: ReviewIssueStats[]
  artifacts: ArtifactMeta[]

  // guided (co-writing) mode, for the selected project
  guidedPending: GuidedPending | null
  guidedStream: string
  guidedBusy: boolean
  guidedError: string | null

  // cover images (data URLs) by project id; null = fetched, none exists
  covers: Record<string, string | null>

  // edit variants (post-finish editing), for the selected project
  editVariants: ProjectSummary[]
  editChapters: { chapter: number; title: string; content: string }[]
  editImages: { chapter: number; dataUrl: string }[]
  editMessages: { role: 'user' | 'assistant'; content: string }[]
  editStream: string
  editBusy: boolean
  editReport: EditReport | null
  editError: string | null
  // ponytail: per-chapter busy flag for single-image fixes; restyle-all busy is read off project.status instead
  imageBusy: Record<number, boolean>

  // navigation actions
  setScreen: (screen: Screen) => void
  goHome: () => Promise<void>

  // loaders
  bootstrap: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshProject: (id: string) => Promise<void>
  loadSettings: () => Promise<void>
  saveSettings: (patch: SettingsPatch) => Promise<void>

  // project lifecycle
  openProject: (project: ProjectSummary) => Promise<void>
  createProject: (input: NewProjectInput) => Promise<void>
  deleteProject: (id: string) => Promise<void>

  // clarify
  loadClarify: (id: string) => Promise<void>
  sendClarify: (text: string) => Promise<void>
  startWriting: (viaProceed: boolean) => Promise<void>

  // pipeline controls
  startProject: (id: string) => Promise<void>
  setIllustrations: (id: string, on: boolean) => Promise<void>
  pauseProject: (id: string) => Promise<void>
  cancelProject: (id: string) => Promise<void>

  // dashboard / export detail
  loadDashboard: (id: string) => Promise<void>
  loadCover: (id: string) => Promise<void>

  // guided (co-writing) mode
  loadGuided: (id: string) => Promise<void>
  approveStep: (id: string) => Promise<void>
  regenerateStep: (id: string) => Promise<void>
  editStep: (id: string, content: string) => Promise<void>
  refineStep: (id: string, message: string) => Promise<void>
  runFree: (id: string) => Promise<void>

  // author's room
  unlockAuthorsRoom: (id: string, confirmTitle: string) => Promise<boolean>
  loadArtifacts: (id: string) => Promise<void>
  readArtifact: (id: string, artifactId: string) => Promise<string>

  // export
  exportSaveAs: (id: string) => Promise<{ path: string } | { cancelled: true }>

  // edit variants (named clones of a finished book for post-finish editing)
  listEditVariants: (sourceProjectId: string) => Promise<void>
  createEditVariant: (sourceProjectId: string, label: string) => Promise<ProjectSummary>
  renameEditVariant: (projectId: string, label: string) => Promise<void>
  deleteEditVariant: (projectId: string, sourceProjectId: string) => Promise<void>
  openEditVariant: (projectId: string) => Promise<void>
  sendEditChat: (req: { message: string; chapter?: number }) => Promise<void>
  /** One selection-popup edit turn: an instruction scoped to a verbatim span in one chapter. */
  sendSelectionEdit: (chapter: number, text: string, instruction: string) => Promise<void>
  renameInBook: (from: string, to: string) => Promise<void>
  undoChapter: (chapter: number) => Promise<void>
  /** Re-renders one chapter's illustration (destructive, no undo). */
  fixChapterImage: (chapter: number, instruction?: string) => Promise<void>
  /** Repaints the cover and every chapter image from a new style description (background job). */
  restyleAllImages: (style: string) => Promise<void>
  /** Runs a proofread pass in the background: 'align' (targeted patch) or 'full-review' (whole-book re-read). */
  runProofread: (mode: 'align' | 'full-review') => Promise<void>
}

function routeForStage(stage: Stage): Screen {
  if (stage === 'intake' || stage === 'clarify') return 'clarify'
  if (stage === 'done') return 'export'
  return 'progress'
}

/** Guided projects mid-run land on the guided co-writing screen; otherwise route by stage. */
function routeForProject(project: ProjectSummary): Screen {
  if (project.guided && project.stage !== 'done' && project.stage !== 'clarify' && project.stage !== 'intake') {
    return 'guided'
  }
  return routeForStage(project.stage)
}

export const useStore = create<AppState>((set, get) => ({
  screen: 'home',
  selectedProjectId: null,
  projects: [],
  settings: null,
  clarifyMessages: [],
  pendingAssistant: null,
  clarifyReady: false,
  clarifyBusy: false,
  clarifyError: null,
  progress: {},
  liveCost: {},
  errors: {},
  activity: {},
  costSummary: null,
  reviewStats: [],
  artifacts: [],
  guidedPending: null,
  guidedStream: '',
  guidedBusy: false,
  guidedError: null,
  covers: {},
  editVariants: [],
  editChapters: [],
  editImages: [],
  editMessages: [],
  editStream: '',
  editBusy: false,
  editReport: null,
  editError: null,
  imageBusy: {},

  setScreen: (screen) => set({ screen }),

  goHome: async () => {
    set({ screen: 'home', selectedProjectId: null })
    await get().refreshProjects()
  },

  bootstrap: async () => {
    await Promise.all([get().refreshProjects(), get().loadSettings()])
  },

  refreshProjects: async () => {
    const list = await api.invoke('project:list')
    set({ projects: list })
  },

  refreshProject: async (id) => {
    try {
      const p = await api.invoke('project:get', id)
      set((state) => ({
        projects: state.projects.some((x) => x.id === id)
          ? state.projects.map((x) => (x.id === id ? p : x))
          : [p, ...state.projects]
      }))
    } catch {
      /* project may have been deleted mid-flight; ignore */
    }
  },

  loadSettings: async () => {
    const settings = await api.invoke('settings:get')
    set({ settings })
  },

  saveSettings: async (patch) => {
    const settings = await api.invoke('settings:set', patch)
    set({ settings })
  },

  openProject: async (project) => {
    set({ selectedProjectId: project.id })
    const screen = routeForProject(project)
    if (screen === 'clarify') {
      await get().loadClarify(project.id)
    } else if (screen === 'guided') {
      await get().loadDashboard(project.id)
      await get().loadGuided(project.id)
    } else {
      await get().loadDashboard(project.id)
    }
    set({ screen })
  },

  createProject: async (input) => {
    const project = await api.invoke('project:create', input)
    set((state) => ({
      projects: [project, ...state.projects],
      selectedProjectId: project.id,
      clarifyMessages: [],
      pendingAssistant: null,
      clarifyReady: false,
      clarifyBusy: false,
      clarifyError: null
    }))
    // A translation has no clarify interview — it lands on the progress screen, ready to start.
    const screen = routeForProject(project)
    if (screen === 'clarify') {
      await get().loadClarify(project.id)
    } else {
      await get().loadDashboard(project.id)
    }
    set({ screen })
  },

  deleteProject: async (id) => {
    await api.invoke('project:delete', id)
    set((state) => ({ projects: state.projects.filter((p) => p.id !== id) }))
  },

  loadClarify: async (id) => {
    set({ pendingAssistant: null, clarifyReady: false, clarifyBusy: false, clarifyError: null })
    const messages = await api.invoke('clarify:history', id)
    set({ clarifyMessages: messages })
  },

  sendClarify: async (text) => {
    const id = get().selectedProjectId
    if (!id) return
    const userMsg: ClarifyMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      round: 0,
      createdAt: new Date().toISOString()
    }
    set((state) => ({
      clarifyMessages: [...state.clarifyMessages, userMsg],
      pendingAssistant: '',
      clarifyBusy: true,
      clarifyReady: false,
      clarifyError: null
    }))
    try {
      await api.invoke('clarify:send', id, text)
    } catch (err) {
      set({ clarifyBusy: false, pendingAssistant: null })
      throw err
    }
  },

  startWriting: async (viaProceed) => {
    const id = get().selectedProjectId
    if (!id) return
    if (viaProceed) await api.invoke('clarify:proceed', id)
    await api.invoke('project:start', id)
    await Promise.all([get().refreshProject(id), get().loadDashboard(id)])
    // Guided books co-write on the guided screen; others watch the spoiler-free dashboard.
    const project = get().projects.find((p) => p.id === id)
    if (project?.guided) {
      await get().loadGuided(id)
      set({ screen: 'guided' })
    } else {
      set({ screen: 'progress' })
    }
  },

  startProject: async (id) => {
    await api.invoke('project:start', id)
    await get().refreshProject(id)
  },

  setIllustrations: async (id, on) => {
    const p = await api.invoke('project:setIllustrations', id, on)
    set((state) => ({
      projects: state.projects.map((x) => (x.id === id ? p : x))
    }))
  },

  pauseProject: async (id) => {
    await api.invoke('project:pause', id)
    await get().refreshProject(id)
  },

  cancelProject: async (id) => {
    await api.invoke('project:cancel', id)
    await get().refreshProject(id)
  },

  loadDashboard: async (id) => {
    try {
      const [costSummary, reviewStats] = await Promise.all([
        api.invoke('project:costs', id),
        api.invoke('project:reviewStats', id)
      ])
      set((state) => ({
        costSummary,
        reviewStats,
        liveCost: { ...state.liveCost, [id]: costSummary.costUsd }
      }))
    } catch {
      /* ignore transient load errors */
    }
  },

  loadGuided: async (id) => {
    try {
      const pending = await api.invoke('guided:current', id)
      set({ guidedPending: pending, guidedStream: '', guidedError: null })
    } catch {
      /* ignore transient load errors */
    }
  },

  approveStep: async (id) => {
    set({ guidedPending: null, guidedStream: '', guidedBusy: true, guidedError: null })
    await api.invoke('guided:approve', id)
    await get().refreshProject(id)
  },

  regenerateStep: async (id) => {
    set({ guidedPending: null, guidedStream: '', guidedBusy: true, guidedError: null })
    await api.invoke('guided:regenerate', id)
    await get().refreshProject(id)
  },

  editStep: async (id, content) => {
    const pending = await api.invoke('guided:edit', id, content)
    set({ guidedPending: pending })
  },

  refineStep: async (id, message) => {
    set({ guidedBusy: true, guidedStream: '', guidedError: null })
    try {
      await api.invoke('guided:refine', id, message)
      await get().loadGuided(id)
      await get().loadDashboard(id)
    } finally {
      set({ guidedBusy: false })
    }
  },

  runFree: async (id) => {
    set({ guidedPending: null, guidedStream: '', guidedBusy: true })
    await api.invoke('guided:runFree', id)
    await get().refreshProject(id)
    set({ screen: 'progress' })
    await get().loadDashboard(id)
  },

  unlockAuthorsRoom: async (id, confirmTitle) => {
    const ok = await api.invoke('authorsRoom:unlock', id, confirmTitle)
    if (ok) {
      await Promise.all([get().loadArtifacts(id), get().refreshProject(id)])
      set({ screen: 'authorsRoom' })
    }
    return ok
  },

  loadArtifacts: async (id) => {
    const artifacts = await api.invoke('authorsRoom:list', id)
    set({ artifacts })
  },

  readArtifact: (id, artifactId) => api.invoke('authorsRoom:read', id, artifactId),

  loadCover: async (id) => {
    if (id in get().covers) return // fetched once (null or a data URL)
    const cover = await api.invoke('project:cover', id)
    set((state) => ({ covers: { ...state.covers, [id]: cover } }))
  },

  exportSaveAs: (id) => api.invoke('export:saveAs', id),

  listEditVariants: async (sourceProjectId) => {
    const variants = await api.invoke('edit:listVariants', sourceProjectId)
    set({ editVariants: variants })
  },

  createEditVariant: async (sourceProjectId, label) => {
    const variant = await api.invoke('edit:createVariant', sourceProjectId, label)
    await get().listEditVariants(sourceProjectId)
    return variant
  },

  renameEditVariant: async (projectId, label) => {
    const variant = await api.invoke('edit:renameVariant', projectId, label)
    if (variant.sourceProjectId) await get().listEditVariants(variant.sourceProjectId)
  },

  deleteEditVariant: async (projectId, sourceProjectId) => {
    await api.invoke('project:delete', projectId)
    await Promise.all([get().listEditVariants(sourceProjectId), get().refreshProjects()])
  },

  openEditVariant: async (projectId) => {
    set({
      selectedProjectId: projectId,
      editMessages: [],
      editStream: '',
      editBusy: false,
      editReport: null,
      editError: null,
      imageBusy: {}
    })
    // refreshProject ensures the variant's summary lands in `projects` (it's never in the
    // Home-loaded list, since edit copies are filtered off the grid) so useSelectedProject() resolves.
    const [chapters, images] = await Promise.all([
      api.invoke('edit:chapters', projectId),
      api.invoke('edit:chapterImages', projectId),
      get().refreshProject(projectId)
    ])
    set({ editChapters: chapters, editImages: images, screen: 'editBook' })
  },

  sendEditChat: async (req) => {
    const id = get().selectedProjectId
    if (!id || get().editBusy) return
    set((state) => ({
      editMessages: [...state.editMessages, { role: 'user', content: req.message }],
      editBusy: true,
      editStream: '',
      editError: null
    }))
    const res = await api.invoke('edit:chat', id, req)
    if (res) {
      set((state) => ({
        editMessages: [...state.editMessages, { role: 'assistant', content: res.reply }],
        editReport: res.report
      }))
      const chapters = await api.invoke('edit:chapters', id)
      set({ editChapters: chapters })
    }
    // res === null means the backend already emitted edit:error — just stop, keep the user message.
    set({ editBusy: false, editStream: '' })
  },

  sendSelectionEdit: async (chapter, text, instruction) => {
    const id = get().selectedProjectId
    if (!id || get().editBusy) return
    set((state) => ({
      editMessages: [...state.editMessages, { role: 'user', content: instruction }],
      editBusy: true,
      editStream: '',
      editError: null
    }))
    const res = await api.invoke('edit:chat', id, {
      message: instruction,
      selection: { chapter, text, instruction }
    })
    if (res) {
      set((state) => ({
        editMessages: [...state.editMessages, { role: 'assistant', content: res.reply }],
        editReport: res.report
      }))
      const chapters = await api.invoke('edit:chapters', id)
      set({ editChapters: chapters })
    }
    // res === null means the backend already emitted edit:error — just stop, keep the user message.
    set({ editBusy: false, editStream: '' })
  },

  renameInBook: async (from, to) => {
    const id = get().selectedProjectId
    if (!id) return
    const report = await api.invoke('edit:rename', id, from, to)
    set({ editReport: report })
    const chapters = await api.invoke('edit:chapters', id)
    set({ editChapters: chapters })
  },

  undoChapter: async (chapter) => {
    const id = get().selectedProjectId
    if (!id) return
    await api.invoke('edit:undo', id, chapter)
    const chapters = await api.invoke('edit:chapters', id)
    set({ editChapters: chapters })
  },

  fixChapterImage: async (chapter, instruction) => {
    const id = get().selectedProjectId
    if (!id) return
    set((state) => ({ imageBusy: { ...state.imageBusy, [chapter]: true } }))
    try {
      const res = await api.invoke('edit:fixImage', id, chapter, instruction)
      set((state) => ({
        editImages: state.editImages.some((i) => i.chapter === res.chapter)
          ? state.editImages.map((i) => (i.chapter === res.chapter ? res : i))
          : [...state.editImages, res]
      }))
    } finally {
      set((state) => ({ imageBusy: { ...state.imageBusy, [chapter]: false } }))
    }
  },

  restyleAllImages: async (style) => {
    const id = get().selectedProjectId
    if (!id) return
    // Kicks off the illustrate stage in the background; pipeline:status reloads
    // editImages/editChapters once it lands back on 'done' (see subscribeEvents).
    await api.invoke('edit:restyleImages', id, style)
    await get().refreshProject(id)
  },

  runProofread: async (mode) => {
    const id = get().selectedProjectId
    if (!id) return
    // Kicks off the align/review stage in the background; pipeline:status reloads
    // editImages/editChapters once it lands back on 'done' (see subscribeEvents).
    await api.invoke('edit:proofread', id, mode)
    await get().refreshProject(id)
  }
}))

/**
 * Subscribe once to every main→renderer event and fold it into the store.
 * Returns an unsubscribe that detaches all listeners.
 */
export function subscribeEvents(): () => void {
  const set = useStore.setState
  const get = useStore.getState

  const unsubs: Array<() => void> = []

  const add = <E extends EventChannel>(
    channel: E,
    handler: (payload: IpcEvents[E]) => void
  ): void => {
    unsubs.push(api.on(channel, handler))
  }

  add('pipeline:progress', (p) => {
    set((state) => ({
      progress: {
        ...state.progress,
        [p.projectId]: {
          stage: p.stage,
          stepKey: p.stepKey,
          chapter: p.chapter,
          ofChapters: p.ofChapters,
          wordsWritten: p.wordsWritten,
          message: p.message
        }
      }
    }))
    void get().refreshProject(p.projectId)
  })

  add('pipeline:activity', (p) => {
    set((state) => {
      const prev = state.activity[p.projectId] ?? []
      const next = [...prev, { at: p.at, line: p.line }]
      if (next.length > 120) next.splice(0, next.length - 120)
      return { activity: { ...state.activity, [p.projectId]: next } }
    })
  })

  add('pipeline:cost', (p) => {
    // The event carries the project's CUMULATIVE cost — replace, never add.
    set((state) => ({ liveCost: { ...state.liveCost, [p.projectId]: p.costUsd } }))
  })

  add('pipeline:status', (p) => {
    set((state) => ({
      projects: state.projects.map((x) =>
        x.id === p.projectId ? { ...x, status: p.status, stage: p.stage } : x
      )
    }))
    void get().refreshProject(p.projectId)
    // Guided co-writing: react to the step lifecycle for the open project.
    if (p.projectId === get().selectedProjectId) {
      if (p.status === 'awaiting') {
        set({ guidedBusy: false })
        void get().loadGuided(p.projectId)
      } else if (p.status === 'running') {
        set({ guidedBusy: true, guidedPending: null, guidedStream: '' })
      } else if (p.status === 'done' && get().screen === 'guided') {
        set({ guidedBusy: false, guidedPending: null })
        void get().loadDashboard(p.projectId)
        set({ screen: 'export' })
      } else if (p.status === 'done' && get().screen === 'editBook') {
        // A restyle-all run just finished (illustrate stage back to 'done') — reload the
        // repainted images, plus chapters since a later proofread phase can also touch text.
        void Promise.all([
          api.invoke('edit:chapterImages', p.projectId),
          api.invoke('edit:chapters', p.projectId)
        ]).then(([images, chapters]) => {
          set({ editImages: images, editChapters: chapters })
        })
      }
    }
  })

  add('pipeline:error', (p) => {
    set((state) => ({ errors: { ...state.errors, [p.projectId]: p.message } }))
  })

  add('clarify:token', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return { pendingAssistant: (state.pendingAssistant ?? '') + p.delta }
    })
  })

  add('clarify:error', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return { clarifyError: p.message, pendingAssistant: null, clarifyBusy: false }
    })
  })

  add('guided:token', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return { guidedStream: state.guidedStream + p.delta }
    })
  })

  add('guided:error', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return { guidedError: p.message, guidedBusy: false }
    })
  })

  add('edit:token', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return { editStream: state.editStream + p.delta }
    })
  })

  add('edit:error', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return { editError: p.message, editBusy: false }
    })
  })

  add('clarify:message', (p) => {
    set((state) => {
      if (p.projectId !== state.selectedProjectId) return {}
      return {
        clarifyMessages: [...state.clarifyMessages, p.message],
        pendingAssistant: null,
        clarifyReady: p.ready,
        clarifyBusy: false,
        clarifyError: null
      }
    })
  })

  return () => {
    for (const unsub of unsubs) unsub()
  }
}

// --- small derived helpers used across screens ---

export function useSelectedProject(): ProjectSummary | undefined {
  return useStore((s) =>
    s.selectedProjectId ? s.projects.find((p) => p.id === s.selectedProjectId) : undefined
  )
}
