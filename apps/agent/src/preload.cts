/**
 * The only bridge between the agent window and the main process (sandboxed, context-isolated).
 * The window has no Node.js and makes no network requests itself.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agent', {
  state: () => ipcRenderer.invoke('state'),
  notice: (apiUrl: string) => ipcRenderer.invoke('notice', apiUrl),
  pair: (input: { apiUrl: string; code: string; deviceName: string; consentNoticeVersion: string }) => ipcRenderer.invoke('pair', input),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  answerChallenge: (id: string) => ipcRenderer.invoke('challenge-answer', id),
  quit: () => ipcRenderer.invoke('quit'),
  onState: (cb: (s: unknown) => void) => { ipcRenderer.on('state-changed', (_e, s: unknown) => cb(s)); },
});
