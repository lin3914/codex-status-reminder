"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { readFrontmostBundleIdentifier } = require("../../ElectronApp/frontmost-app");
const resourcesPath = "/Applications/CodeX状态提醒.app/Contents/Resources";

(async () => {
  const calls = [];
  const options = {
    resourcesPath, fsModule: { existsSync: () => true },
    execFile(command, args, settings, callback) {
      calls.push({ command, args, settings });
      setImmediate(() => callback(null, "com.apple.finder\n"));
    }
  };
  const result = readFrontmostBundleIdentifier(options);
  assert(result instanceof Promise, "foreground query must be asynchronous");
  assert.equal(await result, "com.apple.finder");
  assert(calls[0].command.endsWith("/Recovery/CodexCompanionRecovery"));
  assert.deepEqual(calls[0].args, ["--frontmost-bundle-id"]);
  assert.equal(calls[0].settings.timeout, 2_000);
  assert.equal(await readFrontmostBundleIdentifier(), null);
  assert.equal(await readFrontmostBundleIdentifier({
    ...options, fsModule: { existsSync: () => false }
  }), null);
  for (const output of ["", 'bundleID="com.apple.finder"', "unknown", "com.apple.finder\nextra"]) {
    assert.equal(await readFrontmostBundleIdentifier({
      ...options, execFile(_command, _args, _settings, callback) { callback(null, output); }
    }), null, "invalid output must remain unknown, never imply Codex is in the background");
  }
  assert.equal(await readFrontmostBundleIdentifier({
    ...options, execFile(_command, _args, _settings, callback) { callback(new Error("timeout"), ""); }
  }), null);
  assert.equal(await readFrontmostBundleIdentifier({
    ...options, execFile() { throw new Error("spawn failed"); }
  }), null);
  const source = fs.readFileSync(path.join(__dirname, "../../NativeRecovery/main.swift"), "utf8");
  assert.match(source, /NSWorkspace\.shared\.frontmostApplication\?\.bundleIdentifier/);
  assert(source.indexOf('CommandLine.arguments[1] == "--frontmost-bundle-id"')
    < source.indexOf("guard let controller = RecoveryController"),
    "query mode must exit before any recovery or preference writes");
  const main = fs.readFileSync(path.join(__dirname, "../../ElectronApp/main.js"), "utf8");
  assert.doesNotMatch(main, /lsappinfo/, "no OS-specific text parsing in foreground detection");
  assert.match(main, /await handleCompletionNotifications\(/);
  const build = fs.readFileSync(path.join(__dirname, "../../scripts/build-electron-app.sh"), "utf8");
  assert.match(build, /ElectronApp\/frontmost-app\.js.*\$stage_dir\/frontmost-app\.js/,
    "foreground bridge must be included in the shipped ASAR, not just the source checkout");
  console.log("PASS frontmost-app: public macOS API, asynchronous query, safe unknown failures");
})().catch((error) => { console.error(error); process.exitCode = 1; });
