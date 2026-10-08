"use strict";
const path = require("path");
const { pathToFileURL } = require("url");

function rendererURL(base, file) {
  return pathToFileURL(path.join(base, "renderer", file)).href;
}

function protectRendererWindow(win, expectedURL) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const name of ["will-navigate", "will-frame-navigate"]) {
    contents.on(name, (event, url) => {
      if (url !== expectedURL) event.preventDefault();
    });
  }
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function trustedRendererEvent(event, win, expectedURL) {
  if (!win || win.isDestroyed() || event?.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  return Boolean(frame && frame === win.webContents.mainFrame
    && frame.url === expectedURL && win.webContents.getURL() === expectedURL);
}

module.exports = { rendererURL, protectRendererWindow, trustedRendererEvent };
