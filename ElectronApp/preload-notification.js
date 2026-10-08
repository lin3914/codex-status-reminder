"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionNotification", {
  ready() {
    ipcRenderer.send("companion:notification-message", { type: "ready" });
  },
  open(threadID) {
    ipcRenderer.send("companion:notification-message", {
      type: "open",
      threadID
    });
  },
  close(threadID) {
    ipcRenderer.send("companion:notification-message", {
      type: "close",
      threadID
    });
  },
  toggleExpanded() {
    ipcRenderer.send("companion:notification-message", {
      type: "toggle-expanded"
    });
  },
  onContent(callback) {
    ipcRenderer.on("companion:notification-content", (_event, content) => {
      callback(content);
    });
  }
});
