"use strict";

const assert = require("assert/strict");
const path = require("path");
const {
  BackgroundRecovery,
  appBundlePath,
  gracefulExitMarkerPath,
  recoveryCrashStatePath,
  recoveryHelperPath
} = require("../../ElectronApp/background-recovery");

const resourcesPath = "/Applications/CodeX状态提醒.app/Contents/Resources";
const userDataPath = "/Users/companion-test/Library/Application Support/codex-companion";
assert.equal(
  recoveryHelperPath(resourcesPath),
  "/Applications/CodeX状态提醒.app/Contents/Resources/Recovery/CodexCompanionRecovery"
);
assert.equal(appBundlePath(resourcesPath), "/Applications/CodeX状态提醒.app");
assert.equal(
  gracefulExitMarkerPath(userDataPath),
  path.join(userDataPath, "background-recovery-graceful-exit")
);
assert.equal(
  recoveryCrashStatePath(userDataPath),
  path.join(userDataPath, "background-recovery-crash-state.json")
);

const writes = [];
let spawned = null;
const child = {
  killed: false,
  unref() { this.unreferenced = true; },
  kill(signal) { this.killed = signal === "SIGTERM"; }
};
const recovery = new BackgroundRecovery({
  resourcesPath,
  userDataPath,
  parentPID: 42,
  spawn(command, args, options) {
    spawned = { command, args, options };
    return child;
  },
  fsModule: {
    existsSync(file) {
      return file === recoveryHelperPath(resourcesPath);
    },
    mkdirSync() {},
    rmSync() {},
    writeFileSync(file, value, encoding) {
      writes.push({ file, value, encoding });
    }
  }
});

const start = recovery.start(true);
assert.deepEqual(start, { enabled: true, available: true });
assert.equal(spawned.command, recoveryHelperPath(resourcesPath));
assert.equal(spawned.args[0], "42");
assert.equal(spawned.args[1], "/Applications/CodeX状态提醒.app");
assert.equal(spawned.args[2], gracefulExitMarkerPath(userDataPath));
assert.equal(spawned.args[3], recoveryCrashStatePath(userDataPath));
assert.equal(typeof spawned.args[4], "string");
assert.equal(child.unreferenced, true);
assert.equal(recovery.markGracefulExit(), true);
assert.equal(recovery.markStableStartup(), true);
assert.equal(writes.length, 1);
assert.equal(writes[0].file, gracefulExitMarkerPath(userDataPath));
assert.equal(writes[0].value, spawned.args[4]);
recovery.stop({ graceful: true });
assert.equal(child.killed, true);

const unavailable = new BackgroundRecovery({
  resourcesPath,
  userDataPath,
  fsModule: { existsSync: () => false }
});
assert.deepEqual(unavailable.start(true), { enabled: false, available: false });

console.log("PASS background-recovery");
