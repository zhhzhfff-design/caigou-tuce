const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadItems: () => ipcRenderer.invoke("load-items"),
  saveItems: items => ipcRenderer.invoke("save-items", items),

  pickImages: () => ipcRenderer.invoke("pick-images"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  importPaths: files => ipcRenderer.invoke("import-paths", files),
  importUrls: urls => ipcRenderer.invoke("import-urls", urls),

  pickTable: () => ipcRenderer.invoke("pick-table"),
  readTableFile: p => ipcRenderer.invoke("read-table-file", p),
  makeTemplate: (opts) => ipcRenderer.invoke("make-template", opts),
  exportList: (items, opts) => ipcRenderer.invoke("export-list", items, opts),
  exportPack: (items, opts) => ipcRenderer.invoke("export-pack", items, opts),

  replaceImage: payload => ipcRenderer.invoke("replace-image", payload),
  downloadOne: payload => ipcRenderer.invoke("download-one", payload),
  addImageBuffer: payload => ipcRenderer.invoke("add-image-buffer", payload),
  getPathForFile: file => {
    try { return webUtils.getPathForFile(file); } catch { return ""; }
  },

  openUrl: url => ipcRenderer.invoke("open-url", url),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  deleteItem: it => ipcRenderer.invoke("delete-item", it),
  deleteMany: ids => ipcRenderer.invoke("delete-many", ids),
  clearAll: () => ipcRenderer.invoke("clear-all"),

  onProgress: cb => {
    const handler = (_e, d) => cb(d);
    ipcRenderer.on("import-progress", handler);
    return () => ipcRenderer.removeListener("import-progress", handler);
  }
});
