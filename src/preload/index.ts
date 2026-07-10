import { contextBridge, ipcRenderer } from 'electron'
import type { PreloadApi } from '@shared/ipc-contract'

/**
 * Typed bridge exposed to the renderer as `window.api`.
 * The renderer only ever touches this object — never ipcRenderer directly.
 */
const api: PreloadApi = {
  invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel, listener) {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload as never)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
