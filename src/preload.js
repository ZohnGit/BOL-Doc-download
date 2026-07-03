const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bolApi", {
  getState: () => ipcRenderer.invoke("app:getState"),
  toggleCapture: () => ipcRenderer.invoke("capture:toggle"),
  runCapture: () => ipcRenderer.invoke("capture:run"),
  loadErpFile: () => ipcRenderer.invoke("file:loadErp"),
  loadTemplateFile: () => ipcRenderer.invoke("file:loadTemplate"),
  exportProcessedFile: () => ipcRenderer.invoke("file:exportProcessed"),
  onStateUpdate: (callback) => {
    ipcRenderer.on("state:update", (_event, payload) => callback(payload));
  },
  onCaptureBatch: (callback) => {
    ipcRenderer.on("capture:batch", (_event, payload) => callback(payload));
  },
  onAppError: (callback) => {
    ipcRenderer.on("app:error", (_event, payload) => callback(payload));
  },
  onBubbleUpdate: (callback) => {
    ipcRenderer.on("bubble:update", (_event, payload) => callback(payload));
  },
  openExternalHelp: () => {
    ipcRenderer.send("app:help");
  },
});

