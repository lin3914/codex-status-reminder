"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("webkit", {
  messageHandlers: {
    panel: {
      postMessage(payload) {
        ipcRenderer.send("companion:panel-message", payload);
      }
    }
  }
});

contextBridge.exposeInMainWorld("companion", {
  onSnapshot(callback) {
    ipcRenderer.on("companion:snapshot", (_event, snapshot) => callback(snapshot));
  },
  onPosition(callback) {
    ipcRenderer.on("companion:position", (_event, position) => callback(position));
  },
  onPresent(callback) {
    ipcRenderer.on("companion:panel-present", (_event, request) => callback(request));
  },
  onVisibility(callback) {
    ipcRenderer.on("companion:panel-visibility", (_event, state) => callback(state));
  }
});
