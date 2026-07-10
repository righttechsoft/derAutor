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
} from './domain'
import type { EditChatRequest, EditChatResult, EditOp, EditReport } from './editOps'

/**
 * Single source of truth for the IPC surface.
 * Commands: renderer → main via ipcRenderer.invoke / ipcMain.handle.
 * Events: main → renderer via webContents.send.
 *
 * SPOILER BOUNDARY: nothing in these payloads may carry artifact content,
 * plot details, or issue descriptions unless the project's author's room is
 * unlocked (enforced in main, services/spoilerGate.ts).
 */

export interface IpcCommands {
  'settings:get': { args: []; result: AppSettings }
  'settings:set': {
    args: [
      Partial<{
        anthropicKey: string
        openaiKey: string
        plannerModel: string
        drafterModel: string
        authorName: string
        textProvider: 'api' | 'claude-code'
      }>
    ]
    result: AppSettings
  }

  'project:list': { args: []; result: ProjectSummary[] }
  'project:get': { args: [projectId: string]; result: ProjectSummary }
  'project:create': { args: [input: NewProjectInput]; result: ProjectSummary }
  'project:delete': { args: [projectId: string]; result: void }
  /** Starts or resumes the background pipeline from the current stage. */
  'project:start': { args: [projectId: string]; result: void }
  /**
   * Turns illustrations on/off for an existing project. Turning them on for a
   * finished book re-enters the illustrate stage (start the pipeline after).
   */
  'project:setIllustrations': { args: [projectId: string, on: boolean]; result: ProjectSummary }
  'project:pause': { args: [projectId: string]; result: void }
  'project:cancel': { args: [projectId: string]; result: void }
  'project:costs': { args: [projectId: string]; result: CostSummary }
  'project:reviewStats': { args: [projectId: string]; result: ReviewIssueStats[] }
  /** The cover image as a data URL (spoiler-safe — painted from the opening), or null if none. */
  'project:cover': { args: [projectId: string]; result: string | null }
  /** Spoiler-free back-cover blurb (from book_meta, built only from the setup), or null if not written yet. */
  'project:annotation': { args: [projectId: string]; result: string | null }

  'clarify:history': { args: [projectId: string]; result: ClarifyMessage[] }
  /** Sends a user answer; assistant reply streams via clarify:token then clarify:message. */
  'clarify:send': { args: [projectId: string, text: string]; result: void }
  /** User overrides the readiness verdict and moves on to generation. */
  'clarify:proceed': { args: [projectId: string]; result: void }

  /** Writes the finished FB2 to the given path (save-dialog lives in main). */
  'export:saveAs': { args: [projectId: string]; result: { path: string } | { cancelled: true } }

  'authorsRoom:unlock': { args: [projectId: string, confirmTitle: string]; result: boolean }
  'authorsRoom:list': { args: [projectId: string]; result: ArtifactMeta[] }
  'authorsRoom:read': { args: [projectId: string, artifactId: string]; result: string }

  // --- Guided (co-writing) mode. Content-bearing, gated to guided projects. ---
  /** The step awaiting the author's decision (with its live content + refine chat), or null. */
  'guided:current': { args: [projectId: string]; result: GuidedPending | null }
  /** Approve the pending step; the pipeline runs the next one. */
  'guided:approve': { args: [projectId: string]; result: void }
  /** Discard the pending step's draft and re-run it. */
  'guided:regenerate': { args: [projectId: string]; result: void }
  /** Replace the pending step's artifact with a hand-edited version (does not resume). */
  'guided:edit': { args: [projectId: string, content: string]; result: GuidedPending | null }
  /** One interactive refine turn on the pending step (streams via guided:token). */
  'guided:refine': { args: [projectId: string, message: string]; result: void }
  /** Turn guided mode off and run straight to done. */
  'guided:runFree': { args: [projectId: string]; result: void }

  // --- Edit variants: named clones of a finished book for post-finish editing. ---
  'edit:listVariants': { args: [sourceProjectId: string]; result: ProjectSummary[] }
  'edit:createVariant': { args: [sourceProjectId: string, label: string]; result: ProjectSummary }
  'edit:renameVariant': { args: [projectId: string, label: string]; result: ProjectSummary }
  /** Read-only chapter prose of an edit variant (throws if not an edit variant). */
  'edit:chapters': {
    args: [projectId: string]
    result: { chapter: number; title: string; content: string }[]
  }
  /** Chapter illustrations of an edit variant as data URLs (throws if not an edit variant). */
  'edit:chapterImages': { args: [projectId: string]; result: { chapter: number; dataUrl: string }[] }
  /** One interactive edit turn: streams a reply (edit:token) then applies patch ops. Null on error (edit:error was sent). */
  'edit:chat': { args: [projectId: string, req: EditChatRequest]; result: EditChatResult | null }
  /** Applies pre-built anchored find/replace ops directly (no LLM). */
  'edit:applyOps': { args: [projectId: string, ops: EditOp[]]; result: EditReport }
  /** Global exact find/replace across every chapter (no LLM). */
  'edit:rename': { args: [projectId: string, from: string, to: string]; result: EditReport }
  /** Restores the previous version of one chapter's text (append-only undo). */
  'edit:undo': { args: [projectId: string, chapter: number]; result: void }
  /** Re-renders one chapter's illustration, optionally steered by a fix instruction. */
  'edit:fixImage': {
    args: [projectId: string, chapter: number, instruction?: string]
    result: { chapter: number; dataUrl: string }
  }
  /** Restyles the cover and every chapter image from a new text description (re-enters illustrate). */
  'edit:restyleImages': { args: [projectId: string, style: string]; result: void }
  /** Runs a proofread pass on a finished edit variant: 'align' (targeted — only what the edits touched) or 'full-review' (reuse the whole-book review stage). */
  'edit:proofread': { args: [projectId: string, mode: 'align' | 'full-review']; result: void }
}

export interface IpcEvents {
  'pipeline:progress': {
    projectId: string
    stage: Stage
    stepKey: string
    chapter: number | null
    ofChapters: number | null
    wordsWritten: number
    message: string // spoiler-free, e.g. "Drafting chapter 7 of 30"
  }
  'pipeline:cost': { projectId: string; costUsd: number; outputTokens: number }
  /** Spoiler-free activity feed line: step lifecycle, api calls, retries. */
  'pipeline:activity': { projectId: string; at: string; line: string }
  'pipeline:status': { projectId: string; status: ProjectSummary['status']; stage: Stage }
  'pipeline:error': { projectId: string; stepKey: string; message: string }
  'clarify:token': { projectId: string; delta: string }
  'clarify:message': { projectId: string; message: ClarifyMessage; ready: boolean }
  'clarify:error': { projectId: string; message: string }
  /** Guided mode: a token of the step/refine text being written live. */
  'guided:token': { projectId: string; delta: string }
  'guided:error': { projectId: string; message: string }
  /** Edit chat: a token of the conversational reply being written live. */
  'edit:token': { projectId: string; delta: string }
  'edit:error': { projectId: string; message: string }
}

export type CommandChannel = keyof IpcCommands
export type EventChannel = keyof IpcEvents

export interface PreloadApi {
  invoke<C extends CommandChannel>(
    channel: C,
    ...args: IpcCommands[C]['args']
  ): Promise<IpcCommands[C]['result']>
  on<E extends EventChannel>(channel: E, listener: (payload: IpcEvents[E]) => void): () => void
}
