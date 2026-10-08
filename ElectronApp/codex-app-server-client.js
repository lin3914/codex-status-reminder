"use strict";

const childProcess = require("child_process");
const { EventEmitter } = require("events");

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_STDOUT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BUFFER_BYTES = 16 * 1024;

class CodexAppServerError extends Error {
  constructor(message, {
    code = "APP_SERVER_ERROR",
    cause = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedAppend(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= maxBytes
    ? combined
    : combined.subarray(combined.length - maxBytes);
}

class CodexAppServerClient extends EventEmitter {
  constructor({
    executablePath,
    appVersion = "unknown",
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnImpl = childProcess.spawn,
    environment = process.env
  } = {}) {
    super();
    this.executablePath = executablePath;
    this.appVersion = appVersion;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.environment = environment;
    this.process = null;
    this.startPromise = null;
    this.stopping = false;
    this.initialized = false;
    this.nextID = 1;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = Buffer.alloc(0);
  }

  isConnected() {
    return Boolean(
      this.initialized
      && this.process
      && this.process.exitCode === null
      && !this.process.killed
    );
  }

  async start() {
    if (this.isConnected()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startOnce() {
    if (typeof this.executablePath !== "string" || !this.executablePath) {
      throw new CodexAppServerError("Codex executable is unavailable", {
        code: "CODEX_BINARY_UNAVAILABLE"
      });
    }
    this.stop();
    this.stopping = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = Buffer.alloc(0);

    const environment = { ...this.environment };
    delete environment.ELECTRON_RUN_AS_NODE;
    let spawned;
    try {
      spawned = this.spawnImpl(
        this.executablePath,
        ["app-server", "--listen", "stdio://"],
        {
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );
    } catch (error) {
      throw new CodexAppServerError(
        `Unable to start Codex app-server: ${errorMessage(error)}`,
        { code: "APP_SERVER_START_FAILED", cause: error }
      );
    }
    this.process = spawned;
    spawned.stdout?.on("data", (chunk) => this.ingest(chunk));
    spawned.stderr?.on("data", (chunk) => {
      this.stderrBuffer = boundedAppend(
        this.stderrBuffer,
        chunk,
        MAX_STDERR_BUFFER_BYTES
      );
    });
    spawned.once("error", (error) => this.handleExit(error));
    spawned.once("exit", (code, signal) => {
      const exitReason = signal || (code ?? "unknown");
      this.handleExit(new CodexAppServerError(
        `Codex app-server exited (${exitReason})`,
        { code: "APP_SERVER_EXITED" }
      ));
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_companion",
        title: "Codex Companion",
        version: this.appVersion
      },
      capabilities: {
        experimentalApi: false
      }
    });
    this.notify("initialized", {});
    this.initialized = true;
    this.emit("connected");
  }

  async readRateLimits() {
    await this.start();
    return this.request("account/rateLimits/read", null);
  }

  request(method, params) {
    const processReference = this.process;
    if (
      !processReference
      || processReference.exitCode !== null
      || processReference.killed
      || !processReference.stdin?.writable
    ) {
      return Promise.reject(new CodexAppServerError(
        "Codex app-server is not connected",
        { code: "APP_SERVER_NOT_CONNECTED" }
      ));
    }
    const id = this.nextID++;
    const body = {
      jsonrpc: "2.0",
      id,
      method
    };
    if (params !== null && params !== undefined) body.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CodexAppServerError(
          `${method} timed out`,
          { code: "APP_SERVER_TIMEOUT" }
        ));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        processReference.stdin.write(`${JSON.stringify(body)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexAppServerError(
          `Unable to send ${method}: ${errorMessage(error)}`,
          { code: "APP_SERVER_WRITE_FAILED", cause: error }
        ));
      }
    });
  }

  notify(method, params) {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) return false;
    const body = {
      jsonrpc: "2.0",
      method,
      params
    };
    stdin.write(`${JSON.stringify(body)}\n`);
    return true;
  }

  ingest(chunk) {
    this.stdoutBuffer = boundedAppend(
      this.stdoutBuffer,
      chunk,
      MAX_STDOUT_BUFFER_BYTES
    );
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0A);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (
      message
      && Object.prototype.hasOwnProperty.call(message, "id")
      && !Object.prototype.hasOwnProperty.call(message, "method")
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerError(
          message.error.message || `${pending.method} failed`,
          {
            code: message.error.code === -32601
              ? "APP_SERVER_METHOD_UNSUPPORTED"
              : "APP_SERVER_REQUEST_FAILED"
          }
        ));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (typeof message?.method === "string") {
      this.emit("notification", {
        method: message.method,
        params: message.params || {}
      });
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        this.process?.stdin?.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: "Codex Companion does not implement server requests"
          }
        })}\n`);
      }
    }
  }

  handleExit(error) {
    if (!this.process) return;
    const expected = this.stopping;
    this.detachProcess();
    this.rejectPending(error);
    if (!expected) {
      this.emit("disconnected", {
        code: error?.code || "APP_SERVER_EXITED",
        message: errorMessage(error),
        stderr: this.stderrBuffer.toString("utf8").trim()
      });
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  detachProcess() {
    const processReference = this.process;
    this.process = null;
    this.initialized = false;
    if (!processReference) return;
    processReference.stdout?.removeAllListeners();
    processReference.stderr?.removeAllListeners();
    processReference.removeAllListeners("error");
    processReference.removeAllListeners("exit");
  }

  stop() {
    this.stopping = true;
    const processReference = this.process;
    this.detachProcess();
    this.rejectPending(new CodexAppServerError(
      "Codex app-server stopped",
      { code: "APP_SERVER_STOPPED" }
    ));
    if (processReference) {
      try {
        processReference.stdin?.end();
      } catch {
      }
      if (processReference.exitCode === null && !processReference.killed) {
        try {
          processReference.kill("SIGTERM");
        } catch {
        }
      }
    }
    this.stopping = false;
  }
}

module.exports = {
  CodexAppServerClient,
  CodexAppServerError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_STDERR_BUFFER_BYTES,
  MAX_STDOUT_BUFFER_BYTES
};
