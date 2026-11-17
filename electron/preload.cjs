// Preload bridge for the desktop build.
//
// The renderer is sandboxed and cannot open a native dialog or stat a path.
// This exposes exactly one capability — "ask the user to pick a folder" — and
// nothing else: no filesystem, no child processes, no arbitrary IPC.
//
// Every value the main process returns is treated as data by the renderer. The
// main process re-validates anything it is later asked to trust, so a page can
// not grant itself access to a directory by claiming it was picked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__AMC_DESKTOP__', {
  /**
   * Ask the OS for a directory.
   * @returns {Promise<{path: string, title: string} | null>} null when the user cancels.
   */
  pickDirectory: () => ipcRenderer.invoke('amc:pick-directory'),

  /** Whether this renderer is running inside the desktop shell at all. */
  isDesktop: true,
});
