"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("webkit", {
  messageHandlers: {
    dot: {
      postMessage(payload) {
        ipcRenderer.send("companion:dot-message", payload);
      }
    }
  }
});

contextBridge.exposeInMainWorld("companion", {
  onSnapshot(callback) {
    ipcRenderer.on("companion:snapshot", (_event, snapshot) => callback(snapshot));
  }
});
