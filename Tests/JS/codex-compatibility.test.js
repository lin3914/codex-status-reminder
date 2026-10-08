"use strict";

const assert = require("assert/strict");
const { createHash } = require("crypto");
const path = require("path");
const {
  appBundleForExecutable,
  codexExecutableCandidates,
  discoverCodexExecutable
} = require("../../ElectronApp/codex-discovery");
const {
  buildThreadQuery,
  extractUnreadThreadIds,
  extractUnreadState,
  localUnreadHostKey,
  unreadIdentityKey
} = require("../../ElectronApp/codex-state");

const home = "/Users/example";
const movedBundleBinary = "/Volumes/Tools/Codex.app/Contents/Resources/codex";
const candidates = codexExecutableCandidates({
  home,
  environment: {
    CODEX_COMPANION_CODEX_BINARY: "/custom/codex",
    PATH: "/custom/bin:/usr/bin"
  },
  spotlightPaths: [movedBundleBinary]
});
assert.equal(candidates[0], "/custom/codex");
assert(candidates.includes(path.join(home, "Applications/Codex.app/Contents/Resources/codex")));
assert(candidates.includes(movedBundleBinary));
assert.equal(
  discoverCodexExecutable({
    home,
    environment: { PATH: "" },
    spotlightPaths: [movedBundleBinary],
    isExecutable: (candidate) => candidate === movedBundleBinary
  }),
  movedBundleBinary
);
assert.equal(appBundleForExecutable(movedBundleBinary), "/Volumes/Tools/Codex.app");
const newBundleBinary = "/Volumes/Tools/Codex.app/Contents/Resources/codex-cli/bin/codex";
assert.equal(appBundleForExecutable(newBundleBinary), "/Volumes/Tools/Codex.app");
assert.equal(appBundleForExecutable("/Volumes/Tools/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), "/Volumes/Tools/Codex.app");
assert(candidates.includes(path.join(home, "Applications/Codex.app/Contents/Resources/codex-cli/bin/codex")));
assert.equal(discoverCodexExecutable({
  home, environment: { PATH: "" }, spotlightPaths: [movedBundleBinary],
  isExecutable: (candidate) => candidate === newBundleBinary || candidate === "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" || candidate === movedBundleBinary
}), "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "current bundled runtime must outrank stale Spotlight copies");

assert.deepEqual(
  extractUnreadThreadIds({
    "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": { local: ["a"] },
      "unread-thread-ids-by-host-v2": { local: ["a", "a", "b"] }
    }
  }),
  ["a", "b"]
);

const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const syntheticAuth = (account, user) => ({
  auth_mode: "chatgpt",
  tokens: { access_token: `test.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: account, user_id: user }
  })).toString("base64url")}.test` }
});
const identity = hash(["chatgpt", "account-a", "user-a"]);
const otherIdentity = hash(["chatgpt", "account-b", "user-b"]);
const host = "local:" + hash(["local", "local", null]);
assert.equal(unreadIdentityKey(syntheticAuth("account-a", "user-a")), identity);
assert.equal(unreadIdentityKey({ auth_mode: "chatgpt", tokens: { access_token: "broken" } }), null);
assert.equal(unreadIdentityKey(null), null);
assert.equal(localUnreadHostKey({}), host);
assert.equal(localUnreadHostKey({ CODEX_APP_SERVER_WS_URL: "ws://localhost:8000" }),
  "local:" + hash(["local", "local", "ws://localhost:8000"]));
assert.equal(localUnreadHostKey({ CODEX_APP_SERVER_WS_URL: "ws://localhost:8000", CODEX_APP_SERVER_FORCE_CLI: "1" }), host);
const scoped = {
  "electron-thread-read-state-v1": {
    version: 1,
    unreadByIdentity: {
      [identity]: { [host]: [" current ", "current", "", null], "local:other": ["stale-host"], "remote:one": ["remote"], "durable:one": ["cloud"] },
      [otherIdentity]: { [host]: ["other-account"] }
    },
    legacyMigration: { identityKey: identity, unreadThreadIdsByHostId: { local: ["migration-stale"] }, adoptedHostIds: { local: host } }
  },
  "electron-persisted-atom-state": { "unread-thread-ids-by-host-v1": { local: ["legacy-stale"] } }
};
assert.deepEqual(extractUnreadState(scoped, { identityKey: identity, hostKey: host }), { ids: ["current"], available: true });
assert.deepEqual(extractUnreadState(scoped, { identityKey: otherIdentity, hostKey: host }), { ids: ["other-account"], available: true });
assert.deepEqual(extractUnreadState(scoped), { ids: [], available: false }, "unknown account must not merge all identities");
assert.equal(extractUnreadState(scoped, { identityKey: "missing", hostKey: host }).available, false);
assert.equal(extractUnreadState(scoped, { identityKey: identity, hostKey: "local:missing" }).available, false);
scoped["electron-thread-read-state-v1"].unreadByIdentity[identity][host] = [];
assert.deepEqual(extractUnreadState(scoped, { identityKey: identity, hostKey: host }), { ids: [], available: true }, "modern empty set must not resurrect migration / legacy unread IDs");
scoped["electron-thread-read-state-v1"].version = 2;
assert.equal(extractUnreadState(scoped, { identityKey: identity, hostKey: host }).available, false, "unknown format must not mark banners viewed");
assert.equal(extractUnreadState({ "electron-thread-read-state-v1": null, ...{
  "electron-persisted-atom-state": scoped["electron-persisted-atom-state"]
} }).available, false);
assert.deepEqual(extractUnreadState({ "electron-persisted-atom-state": { "unread-thread-ids": [] } }), { ids: [], available: true });

const legacyQuery = buildThreadQuery(
  ["id", "rollout_path", "updated_at", "title", "archived"],
  ["019fa123-4567-7890-abcd-123456789012"]
);
assert(legacyQuery.includes("updated_at * 1000"));
assert(!legacyQuery.includes("NULLIF(recency_at_ms"));
assert(legacyQuery.includes("019fa123-4567-7890-abcd-123456789012"));

const currentQuery = buildThreadQuery(
  [
    "id", "rollout_path", "updated_at", "updated_at_ms", "recency_at_ms",
    "name", "title", "preview", "archived", "thread_source", "source", "cwd", "agent_path"
  ],
  []
);
assert(currentQuery.includes("recency_at_ms"));
assert(currentQuery.includes("NOT LIKE 'subagent%'"));
assert.equal(buildThreadQuery(["id"], []), null);

console.log("PASS codex-compatibility");
