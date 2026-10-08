"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionSettings", {
  get: () => ipcRenderer.invoke("companion:settings-get"),
  update: (patch) => ipcRenderer.invoke("companion:settings-update", patch),
  chooseCodexFolder: () => ipcRenderer.invoke("companion:settings-choose-codex-folder"),
  restoreDefaultCodexFolder: () => ipcRenderer.invoke(
    "companion:settings-restore-default-codex"
  ),
  retryCodexConnection: () => ipcRenderer.invoke(
    "companion:settings-retry-codex"
  ),
  openCodex: () => ipcRenderer.invoke(
    "companion:settings-open-codex"
  ),
  openMenuBarSettings: () => ipcRenderer.invoke(
    "companion:settings-open-menu-bar-settings"
  ),
  onChanged(callback) {
    ipcRenderer.on("companion:settings-changed", (_event, settings) => callback(settings));
  }
});
