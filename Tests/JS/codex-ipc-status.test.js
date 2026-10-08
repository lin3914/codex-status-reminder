"use strict";

const assert = require("assert/strict");
const {
  CodexIpcStatusClient,
  LengthPrefixedFrameDecoder
} = require("../../ElectronApp/codex-ipc-status");

const client = new CodexIpcStatusClient({ socketPath: "/tmp/codex-companion-test.sock" });
client.start = () => Promise.resolve();
const calls = [];
client.probe = async (threadId, options) => {
  calls.push({ threadId, force: options?.force === true });
  return "notLoaded";
};

const now = Date.now();
client.statuses.set("stale-active", {
  status: "active",
  observedAt: now - 31_000
});
client.statuses.set("fresh-active", {
  status: "active",
  observedAt: now
});

(async () => {
  await client.refreshCandidates(["stale-active", "fresh-active", "tail-compacted"]);
  assert.deepEqual(calls, [
    { threadId: "stale-active", force: true },
    { threadId: "tail-compacted", force: false }
  ]);

  const decoder = new LengthPrefixedFrameDecoder(1024);
  const payload = Buffer.from(JSON.stringify({ type: "response", id: 1 }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  const frame = Buffer.concat([header, payload]);
  decoder.push(frame.subarray(0, 2));
  assert.equal(decoder.nextFrame(), null);
  decoder.push(frame.subarray(2, 7));
  assert.equal(decoder.nextFrame(), null);
  decoder.push(frame.subarray(7));
  assert.deepEqual(decoder.nextFrame(), payload);

  const oneShot = new CodexIpcStatusClient({
    socketPath: "/tmp/codex-companion-test.sock"
  });
  oneShot.socket = { writable: true, write() {} };
  oneShot.clientId = "companion";
  oneShot.request = async () => ({
    resultType: "success",
    handledByClientId: "codex-owner"
  });
  oneShot.waitForStatus = async () => "active";
  const follows = [];
  oneShot.broadcast = (_method, params) => follows.push(params.following);
  assert.equal(await oneShot.probe("one-shot"), "active");
  assert.deepEqual(follows, [true, false]);
  assert.equal(oneShot.owners.size, 0);

  let mirroredProbeCount = 0;
  oneShot.probe = async () => {
    mirroredProbeCount += 1;
  };
  oneShot.handleMessage({
    type: "broadcast",
    method: "thread-stream-following-changed",
    params: {
      hostId: "local",
      conversationId: "someone-elses-thread",
      following: true
    }
  });
  assert.equal(mirroredProbeCount, 0);
  assert.equal(oneShot.diagnostics().ignoredMessages, 1);

  const revalidated = new CodexIpcStatusClient({
    socketPath: "/tmp/codex-companion-test.sock"
  });
  revalidated.owners.set("finished", "codex-owner");
  revalidated.statuses.set("finished", {
    status: "active",
    observedAt: Date.now() - 20_000
  });
  revalidated.request = async () => ({ resultType: "not-handled" });
  assert.equal(await revalidated.probe("finished", { force: true }), "unknown");
  assert.equal(
    revalidated.statusFor("finished"),
    "active",
    "a transient IPC miss must not create a false zero-count frame"
  );
  assert.equal(revalidated.owners.has("finished"), false);

  revalidated.statuses.set("expired", {
    status: "active",
    observedAt: Date.now() - 60_000,
    unavailableSince: Date.now() - 31_000
  });
  assert.equal(await revalidated.probe("expired", { force: true }), "unknown");
  assert.equal(revalidated.statusFor("expired"), "notLoaded");

  const reconnecting = new CodexIpcStatusClient({
    socketPath: "/tmp/codex-companion-test.sock"
  });
  reconnecting.statuses.set("socket-gap", {
    status: "active",
    observedAt: Date.now() - 20_000
  });
  reconnecting.resetConnectionState(new Error("test disconnect"));
  assert.equal(
    reconnecting.statusFor("socket-gap"),
    "active",
    "socket reconnects must preserve a recent active state"
  );
  console.log("PASS codex-ipc-status");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
