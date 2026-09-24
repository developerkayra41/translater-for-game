import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onInitCapture: (cb: (imageData: string) => void) =>
    ipcRenderer.on('init-capture', (_e, d) => cb(d)),
  sendCroppedImage: (data: string) => ipcRenderer.send('crop-completed', data),
  onTranslationStatus: (cb: (msg: string) => void) =>
    ipcRenderer.on('translation-status', (_e, m) => cb(m)),
  onTranslationResult: (cb: (text: string) => void) =>
    ipcRenderer.on('translation-result', (_e, t) => cb(t)),
  onEditMode: (cb: (on: boolean) => void) =>
    ipcRenderer.on('edit-mode', (_e, on) => cb(on)),
  onShowMode: (cb: (on:boolean) => void) =>
    ipcRenderer.on('show-mode', (_e,on) => cb(on)),
  moveBy: (dx: number, dy: number) => ipcRenderer.send('move-by', dx, dy),
  resizeBy: (dw: number, dh: number) => ipcRenderer.send('resize-by', dw, dh),
});