"use strict";

const assert = require("assert/strict");
const path = require("path");
const {
  CONNECTION_KINDS,
  automaticCodexConnection,
  codexDataFolderEvidence,
  codexConnectionPaths,
  connectionSummary,
  defaultCompatibilityConnection,
  discoverCodexDataHome,
  normalizeCodexConnection,
  resolveSelectedCodexFolder,
  selectedFolderConnection
} = require("../../ElectronApp/codex-connection");

const home = "/Users/companion-test";
const directories = new Map([
  [path.join(home, ".codex"), [
    "state_5.sqlite",
    ".codex-global-state.json",
    "sessions"
  ]],
  ["/Volumes/Work/Codex Data", ["state_6.sqlite", "version.json"]],
  ["/Volumes/Work/.codex", ["state_5.sqlite"]],
  ["/Volumes/Work", []]
]);
const fsModule = {
  accessSync(candidate) {
    if (!directories.has(candidate)) throw new Error("missing");
  },
  readdirSync(candidate) {
    if (!directories.has(candidate)) throw new Error("missing");
    return directories.get(candidate);
  }
};
const defaults = defaultCompatibilityConnection({
  home,
  environment: {},
  fsModule
});
assert.deepEqual(defaults, {
  schemaVersion: 2,
  kind: CONNECTION_KINDS.AUTO_DISCOVERED,
  codexHome: path.join(home, ".codex"),
  readOnly: true,
  securityScopedBookmark: null,
  selectedAt: null,
  discoverySource: "standard"
});

const selected = selectedFolderConnection("/Volumes/Work/Codex Data", {
  home,
  environment: {},
  now: 123
});
assert.equal(selected.kind, CONNECTION_KINDS.USER_SELECTED);
assert.equal(selected.codexHome, "/Volumes/Work/Codex Data");
assert.equal(selected.readOnly, true);
assert.equal(selected.securityScopedBookmark, null);
assert.equal(selected.selectedAt, 123);
assert.equal(selected.discoverySource, null);
assert.deepEqual(codexConnectionPaths(selected), {
  codexHome: "/Volumes/Work/Codex Data",
  globalStatePath: "/Volumes/Work/Codex Data/.codex-global-state.json",
  ipcSocketPath: "/Volumes/Work/Codex Data/ipc/ipc.sock"
});

const invalid = normalizeCodexConnection({
  kind: CONNECTION_KINDS.USER_SELECTED,
  codexHome: "relative/path"
}, { home, environment: {} });
assert.equal(invalid.codexHome, path.join(home, ".codex"));
assert.equal(invalid.kind, CONNECTION_KINDS.AUTO_DISCOVERED);

const summary = connectionSummary(selected, {
  locale: "zh-CN",
  accessSync: () => {},
  fsModule
});
assert.equal(summary.readable, true);
assert.equal(summary.valid, true);
assert.equal(summary.title, "已手动连接 Codex 数据");
assert.match(summary.description, /只读/);

const missingSummary = connectionSummary(
  normalizeCodexConnection({
    kind: CONNECTION_KINDS.AUTO_DISCOVERED,
    codexHome: "/missing"
  }, { home, environment: {} }),
  { locale: "zh-CN", fsModule, discoveryFailures: 2 }
);
assert.equal(missingSummary.manualSelectionAvailable, false);
assert.match(missingSummary.title, /自动寻找/);
const fallbackSummary = connectionSummary(
  normalizeCodexConnection({
    kind: CONNECTION_KINDS.AUTO_DISCOVERED,
    codexHome: "/missing"
  }, { home, environment: {} }),
  { locale: "zh-CN", fsModule, discoveryFailures: 3 }
);
assert.equal(fallbackSummary.manualSelectionAvailable, true);
assert.match(fallbackSummary.description, /手动/);

const environmentHome = "/Volumes/Work/Codex Data";
assert.deepEqual(discoverCodexDataHome({
  home,
  environment: { CODEX_HOME: environmentHome },
  fsModule
}), {
  codexHome: environmentHome,
  discoverySource: "environment",
  readable: true,
  valid: true,
  markers: ["state_6.sqlite", "version.json"]
});

const automatic = automaticCodexConnection({
  home,
  environment: { CODEX_HOME: "/missing" },
  previousConnection: {
    kind: CONNECTION_KINDS.AUTO_DISCOVERED,
    codexHome: "/previous/missing"
  },
  fsModule
});
assert.equal(automatic.codexHome, path.join(home, ".codex"));
assert.equal(automatic.discoverySource, "standard");
assert.equal(
  resolveSelectedCodexFolder("/Volumes/Work", { fsModule }),
  "/Volumes/Work/.codex"
);
assert.equal(resolveSelectedCodexFolder("/invalid", { fsModule }), null);
assert.equal(codexDataFolderEvidence("/Volumes/Work", { fsModule }).valid, false);

console.log("PASS codex-connection");
