"use strict";

const assert = require("assert/strict");
const { EventEmitter, once } = require("events");
const { PassThrough } = require("stream");
const {
  CodexAppServerClient
} = require("../../ElectronApp/codex-app-server-client");

function fakeCodexProcess(onRequest) {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.stdin = new PassThrough();
  process.exitCode = null;
  process.killed = false;
  process.kill = () => {
    process.killed = true;
    process.exitCode = 0;
    process.emit("exit", 0, null);
  };
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      onRequest(JSON.parse(line), process);
    }
  });
  return process;
}

(async () => {
  const requests = [];
  let spawnCount = 0;
  let currentProcess = null;
  const spawnImpl = (executable, args, options) => {
    spawnCount += 1;
    assert.equal(executable, "/portable/codex");
    assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    currentProcess = fakeCodexProcess((request, process) => {
      requests.push(request);
      if (!Object.prototype.hasOwnProperty.call(request, "id")) return;
      const result = request.method === "account/rateLimits/read"
        ? {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 37,
              windowDurationMins: 10_080,
              resetsAt: 1_782_980_690
            }
          }
        }
        : { userAgent: "codex-test" };
      setImmediate(() => {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result
        })}\n`);
      });
    });
    return currentProcess;
  };

  const client = new CodexAppServerClient({
    executablePath: "/portable/codex",
    appVersion: "1.9.3-test",
    spawnImpl,
    requestTimeoutMs: 1_000
  });
  const result = await client.readRateLimits();
  assert.equal(result.rateLimits.primary.usedPercent, 37);
  assert.equal(spawnCount, 1);
  assert.equal(requests[0].method, "initialize");
  assert.equal(requests[0].params.capabilities.experimentalApi, false);
  assert.equal(requests[1].method, "initialized");
  assert.equal(requests[2].method, "account/rateLimits/read");

  const notificationPromise = once(client, "notification");
  currentProcess.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        primary: { usedPercent: 38 }
      }
    }
  })}\n`);
  const [notification] = await notificationPromise;
  assert.equal(notification.method, "account/rateLimits/updated");
  assert.equal(notification.params.rateLimits.primary.usedPercent, 38);

  await client.readRateLimits();
  assert.equal(spawnCount, 1, "one connected client must reuse one process");
  client.stop();
  assert.equal(currentProcess.killed, true);
  console.log("PASS codex-app-server-client");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
