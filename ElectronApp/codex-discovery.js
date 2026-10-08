"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_BINARY_RELATIVE_PATH = path.join("Contents", "Resources", "codex");
const APP_BINARY_RELATIVE_PATHS = [
  path.join("Contents", "Resources", "codex-cli", "bin", "codex"),
  APP_BINARY_RELATIVE_PATH,
  path.join("Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex")
];
const APP_NAMES = ["Codex.app", "ChatGPT.app"];

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || !path.isAbsolute(value)) continue;
    const normalized = path.normalize(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function spotlightCandidates(execFileSync = childProcess.execFileSync) {
  const queries = [
    '(kMDItemCFBundleIdentifier == "com.openai.codex"c || kMDItemCFBundleIdentifier == "com.openai.chat"c || kMDItemFSName == "Codex.app"c || kMDItemFSName == "ChatGPT.app"c)',
    'kMDItemFSName == "codex"c'
  ];
  const results = [];
  for (const query of queries) {
    try {
      const output = execFileSync("/usr/bin/mdfind", [query], {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 2 * 1024 * 1024
      });
      for (const entry of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
        if (entry.endsWith(".app")) {
          results.push(...APP_BINARY_RELATIVE_PATHS.map((relative) => path.join(entry, relative)));
        } else if (path.basename(entry) === "codex") {
          results.push(entry);
        }
      }
    } catch {
    }
  }
  return results;
}

function codexExecutableCandidates({
  home = os.homedir(),
  environment = process.env,
  spotlightPaths = spotlightCandidates()
} = {}) {
  const candidates = [];
  if (path.isAbsolute(environment.CODEX_COMPANION_CODEX_BINARY || "")) {
    candidates.push(environment.CODEX_COMPANION_CODEX_BINARY);
  }
  for (const root of ["/Applications", path.join(home, "Applications")]) {
    for (const name of APP_NAMES) {
      candidates.push(...APP_BINARY_RELATIVE_PATHS.map((relative) => path.join(root, name, relative)));
    }
  }
  candidates.push(...spotlightPaths);
  const pathEntries = String(environment.PATH || "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  for (const directory of pathEntries) candidates.push(path.join(directory, "codex"));
  candidates.push(
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".cargo", "bin", "codex")
  );
  return uniquePaths(candidates);
}

function discoverCodexExecutable(options = {}) {
  const isExecutable = options.isExecutable || ((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return codexExecutableCandidates(options).find(isExecutable) || null;
}

function appBundleForExecutable(executablePath) {
  if (!path.isAbsolute(executablePath || "")) return null;
  for (const relative of APP_BINARY_RELATIVE_PATHS) {
    const marker = path.sep + relative;
    if (executablePath.endsWith(marker)) return executablePath.slice(0, -marker.length);
  }
  return null;
}

module.exports = {
  APP_BINARY_RELATIVE_PATH,
  APP_BINARY_RELATIVE_PATHS,
  appBundleForExecutable,
  codexExecutableCandidates,
  discoverCodexExecutable,
  spotlightCandidates,
  uniquePaths
};
