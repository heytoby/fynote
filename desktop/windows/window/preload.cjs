const { contextBridge, ipcRenderer } = require('electron');

// The renderer never touches the filesystem directly: every call is a narrow,
// validated IPC message handled in the main process.
contextBridge.exposeInMainWorld('fynote', {
  notes: {
    dir: () => ipcRenderer.invoke('fynote:notes:dir'),
    list: () => ipcRenderer.invoke('fynote:notes:list'),
    write: (relativePath, content) => ipcRenderer.invoke('fynote:notes:write', relativePath, content),
    remove: (relativePath) => ipcRenderer.invoke('fynote:notes:remove', relativePath)
  }
});
