"use strict";

const assert = require("assert/strict");
const { EventEmitter } = require("events");
const {
  AppServerQuotaRuntime,
  UNSUPPORTED_RETRY_MS
} = require("../../ElectronApp/quota-data-worker");

class FakeClient extends EventEmitter {
  constructor(readResult) {
    super();
    this.readResult = readResult;
    this.readCount = 0;
    this.stopCount = 0;
  }

  async readRateLimits() {
    this.readCount += 1;
    if (this.readResult instanceof Error) throw this.readResult;
    this.emit("connected");
    return this.readResult;
  }

  isConnected() {
    return this.stopCount === 0;
  }

  stop() {
    this.stopCount += 1;
  }
}

(async () => {
  let now = 1_000_000;
  const emitted = [];
  const fullPayload = {
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: {
        usedPercent: 22,
        windowDurationMins: 300,
        resetsAt: 1_782_393_890
      },
      secondary: {
        usedPercent: 35,
        windowDurationMins: 10_080,
        resetsAt: 1_782_980_690
      }
    }
  };
  const client = new FakeClient(fullPayload);
  const runtime = new AppServerQuotaRuntime({
    executablePath: "/portable/codex",
    appVersion: "test",
    now: () => now,
    clientFactory: () => client,
    emit: (message) => emitted.push(message)
  });
  const result = await runtime.refresh();
  assert.equal(result.source, "codex-app-server");
  assert.equal(result.rateLimits.secondary.usedPercent, 35);
  assert.equal(client.readCount, 1);

  client.emit("notification", {
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        primary: {
          usedPercent: 24,
          windowDurationMins: null
        },
        secondary: { usedPercent: 36 }
      }
    }
  });
  const update = emitted.find((message) => message.type === "quota-updated");
  assert.equal(update.result.source, "codex-app-server-event");
  assert.equal(update.result.rateLimits.primary.windowDurationMins, 300);
  assert.equal(update.result.rateLimits.secondary.usedPercent, 36);
  runtime.stop();

  const unsupported = new Error("method not found");
  unsupported.code = "APP_SERVER_METHOD_UNSUPPORTED";
  const unsupportedClient = new FakeClient(unsupported);
  const oldRuntime = new AppServerQuotaRuntime({
    executablePath: "/portable/old-codex",
    appVersion: "test",
    now: () => now,
    clientFactory: () => unsupportedClient
  });
  await assert.rejects(oldRuntime.refresh(), /method not found/);
  assert.equal(
    oldRuntime.diagnostics().retryAt,
    now + UNSUPPORTED_RETRY_MS,
    "an old Codex version must enter a long retry window"
  );
  await assert.rejects(
    oldRuntime.refresh(),
    (error) => error.code === "APP_SERVER_BACKOFF"
  );
  assert.equal(
    unsupportedClient.readCount,
    1,
    "backoff must prevent repeated process startup"
  );
  now += UNSUPPORTED_RETRY_MS;
  await assert.rejects(oldRuntime.refresh(), /method not found/);
  assert.equal(unsupportedClient.readCount, 2);
  oldRuntime.stop();
  console.log("PASS quota-data-worker");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
