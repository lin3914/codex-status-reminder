"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const projectDirectory = path.resolve(__dirname, "../..");
const mainSource = fs.readFileSync(
  path.join(projectDirectory, "ElectronApp/main.js"),
  "utf8"
);
const preloadSource = fs.readFileSync(
  path.join(projectDirectory, "ElectronApp/preload-panel.js"),
  "utf8"
);
const panelSource = fs.readFileSync(
  path.join(projectDirectory, "Resources/LegacyV11/panel.html"),
  "utf8"
);

const repositionBlock = mainSource.match(
  /function repositionPanel\(\) \{([\s\S]*?)\n\}\n\nfunction closePanel/
)?.[1] || "";

assert.match(repositionBlock, /setPosition\(bounds\.x, bounds\.y, false\)/);
assert.match(repositionBlock, /sendPanelPosition\(\)/);
assert.doesNotMatch(
  repositionBlock,
  /sendPanelSnapshot\(\)/,
  "dragging must not rebuild the whole panel DOM"
);
assert.match(mainSource, /function pointerOverPanelSurface\(\)/);
assert.match(mainSource, /if \(pointerOverPanelSurface\(\)\) return;/);
assert.match(preloadSource, /onPosition\(callback\)/);
assert.match(panelSource, /applyPanelPosition/);
assert.match(panelSource, /onPosition\?\.\(/);

console.log("PASS panel-drag");
