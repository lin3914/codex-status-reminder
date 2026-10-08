"use strict";

const assert = require("assert/strict");
const {
  LEGACY_LAUNCH_AGENT_LABEL,
  loginItemOptions,
  loginItemStatus,
  migrateLegacyLaunchAgent,
  syncLoginItem
} = require("../../ElectronApp/system-services");

assert.deepEqual(loginItemOptions({
  launchAtLogin: false,
}), { openAtLogin: false, openAsHidden: false });
assert.deepEqual(loginItemOptions({
  launchAtLogin: true
}), { openAtLogin: true, openAsHidden: true });

let applied = null;
const fakeApp = {
  setLoginItemSettings(value) { applied = value; },
  getLoginItemSettings() { return { openAtLogin: true, openAsHidden: true }; }
};
assert.deepEqual(syncLoginItem(fakeApp, {
  launchAtLogin: true
}), {
  supported: true,
  applied: true,
  options: { openAtLogin: true, openAsHidden: true }
});
assert.deepEqual(applied, { openAtLogin: true, openAsHidden: true });
assert.deepEqual(loginItemStatus(fakeApp), {
  supported: true,
  enabled: true,
  openAsHidden: true,
  raw: { openAtLogin: true, openAsHidden: true }
});
assert.deepEqual(syncLoginItem(null, {}), {
  supported: false,
  applied: false,
  options: { openAtLogin: false, openAsHidden: false }
});

const legacyPath = "/Users/test/Library/LaunchAgents/com.lindaozhi.codex-companion.plist";
const calls = [];
const files = new Set([legacyPath]);
const fakeFS = {
  existsSync(file) { return files.has(file); },
  unlinkSync(file) { files.delete(file); }
};
const fakeExec = (file, args) => {
  calls.push([file, args]);
  if (file === "/usr/bin/plutil" && args[1] === "Label") {
    return `${LEGACY_LAUNCH_AGENT_LABEL}\n`;
  }
  if (file === "/usr/bin/plutil" && args[1] === "ProgramArguments.0") {
    return "/Applications/Codex Companion.app/Contents/MacOS/Codex Companion\n";
  }
  if (file === "/bin/launchctl" && args[0] === "print") return "loaded";
  if (file === "/bin/launchctl" && args[0] === "bootout") return "";
  throw new Error(`unexpected call ${file} ${args.join(" ")}`);
};
assert.deepEqual(migrateLegacyLaunchAgent({
  home: "/Users/test",
  uid: 502,
  fsModule: fakeFS,
  execFileSync: fakeExec
}), {
  supported: true,
  removed: true,
  reason: "booted-out-and-removed"
});
assert.equal(files.has(legacyPath), false);
assert.ok(calls.some(
  ([file, args]) => file === "/bin/launchctl"
    && args.join(" ") === "bootout gui/502/com.lindaozhi.codex-companion"
));
assert.deepEqual(migrateLegacyLaunchAgent({
  home: "/Users/test",
  uid: 502,
  fsModule: fakeFS,
  execFileSync: fakeExec
}), {
  supported: true,
  removed: false,
  reason: "not-present"
});

console.log("PASS system-services");
