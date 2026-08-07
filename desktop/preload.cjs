const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeDesktop", {
  getState() {
    return ipcRenderer.invoke("desktop:get-state");
  },
  chooseProject() {
    return ipcRenderer.invoke("desktop:choose-project");
  },
  refreshPreview() {
    return ipcRenderer.invoke("desktop:refresh-preview");
  },
  copyPairingToken() {
    return ipcRenderer.invoke("desktop:copy-pairing-token");
  },
  importPreview() {
    return ipcRenderer.invoke("desktop:import-preview");
  },
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop:state", listener);
    return () => ipcRenderer.removeListener("desktop:state", listener);
  },
});
