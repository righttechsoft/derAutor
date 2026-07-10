import type { EventChannel, IpcEvents } from '@shared/ipc-contract'

/**
 * Electron-free event bridge: main/index.ts registers the real sinks at boot;
 * headless tests leave them unset and events become no-ops.
 */

type Sink = (channel: EventChannel, payload: unknown) => void

let sink: Sink | null = null
let powerHook: ((running: boolean) => void) | null = null

export function setEventSink(fn: Sink): void {
  sink = fn
}

export function setPowerHook(fn: (running: boolean) => void): void {
  powerHook = fn
}

export function sendEvent<E extends EventChannel>(channel: E, payload: IpcEvents[E]): void {
  sink?.(channel, payload)
}

export function notifyPipelineRunning(running: boolean): void {
  powerHook?.(running)
}
