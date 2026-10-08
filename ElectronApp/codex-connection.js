"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONNECTION_SCHEMA_VERSION = 2;
const AUTO_DISCOVERY_MANUAL_FALLBACK_ATTEMPTS = 3;
const CONNECTION_KINDS = Object.freeze({
  USER_SELECTED: "user-selected-folder",
  AUTO_DISCOVERED: "auto-discovered",
  LEGACY_COMPATIBLE: "legacy-compatible"
});
const CODEX_DATA_MARKERS = Object.freeze([
  /^state_\d+\.sqlite$/i,
  /^\.codex-global-state\.json$/i,
  /^session_index\.jsonl$/i,
  /^version\.json$/i,
  /^installation_id$/i,
  /^config\.toml$/i,
  /^sessions$/i,
  /^archived_sessions$/i
]);

function normalizedAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value)
    ? path.normalize(value)
    : null;
}

function defaultCodexHome({ home = os.homedir(), environment = process.env } = {}) {
  return normalizedAbsolutePath(environment.CODEX_HOME)
    || path.join(home, ".codex");
}

function codexDataFolderEvidence(directory, {
  fsModule = fs
} = {}) {
  const codexHome = normalizedAbsolutePath(directory);
  if (!codexHome) {
    return { codexHome: null, readable: false, valid: false, markers: [] };
  }
  let names = [];
  try {
    fsModule.accessSync(codexHome, fs.constants.R_OK);
    names = fsModule.readdirSync(codexHome);
  } catch {
    return { codexHome, readable: false, valid: false, markers: [] };
  }
  const markers = names.filter((name) => (
    CODEX_DATA_MARKERS.some((pattern) => pattern.test(name))
  ));
  return {
    codexHome,
    readable: true,
    valid: markers.length > 0,
    markers
  };
}

function isCodexDataDirectory(directory, options = {}) {
  return codexDataFolderEvidence(directory, options).valid;
}

function automaticCodexCandidates({
  home = os.homedir(),
  environment = process.env,
  previousConnection = null,
  additionalCandidates = []
} = {}) {
  const candidates = [
    {
      path: normalizedAbsolutePath(environment.CODEX_HOME),
      source: "environment"
    },
    {
      path: previousConnection?.kind === CONNECTION_KINDS.AUTO_DISCOVERED
        || previousConnection?.kind === CONNECTION_KINDS.LEGACY_COMPATIBLE
        ? normalizedAbsolutePath(previousConnection.codexHome)
        : null,
      source: typeof previousConnection?.discoverySource === "string"
        && previousConnection.discoverySource
        ? previousConnection.discoverySource
        : "previous"
    },
    {
      path: path.join(home, ".codex"),
      source: "standard"
    },
    {
      path: path.join(home, ".config", "codex"),
      source: "xdg"
    },
    {
      path: path.join(home, "Library", "Application Support", "OpenAI", "Codex"),
      source: "openai-support"
    },
    {
      path: path.join(home, "Library", "Application Support", "Codex"),
      source: "codex-support"
    },
    ...additionalCandidates.map((candidate) => (
      typeof candidate === "string"
        ? { path: candidate, source: "additional" }
        : candidate
    ))
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    const resolved = normalizedAbsolutePath(candidate?.path);
    if (!resolved || seen.has(resolved)) return false;
    seen.add(resolved);
    candidate.path = resolved;
    return true;
  });
}

function discoverCodexDataHome(options = {}) {
  const candidates = automaticCodexCandidates(options);
  for (const candidate of candidates) {
    const evidence = codexDataFolderEvidence(candidate.path, options);
    if (evidence.valid) {
      return {
        codexHome: evidence.codexHome,
        discoverySource: candidate.source,
        readable: true,
        valid: true,
        markers: evidence.markers
      };
    }
  }
  const fallback = defaultCodexHome(options);
  const evidence = codexDataFolderEvidence(fallback, options);
  return {
    codexHome: fallback,
    discoverySource: "standard",
    readable: evidence.readable,
    valid: false,
    markers: evidence.markers
  };
}

function normalizeCodexConnection(
  value = {},
  { home = os.homedir(), environment = process.env } = {}
) {
  const source = value && typeof value === "object" ? value : {};
  const selectedPath = normalizedAbsolutePath(source.codexHome);
  const explicit = source.kind === CONNECTION_KINDS.USER_SELECTED
    && selectedPath;
  const automatic = (
    source.kind === CONNECTION_KINDS.AUTO_DISCOVERED
    || source.kind === CONNECTION_KINDS.LEGACY_COMPATIBLE
  ) && selectedPath;
  return {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    kind: explicit
      ? CONNECTION_KINDS.USER_SELECTED
      : CONNECTION_KINDS.AUTO_DISCOVERED,
    codexHome: explicit || automatic
      ? selectedPath
      : defaultCodexHome({ home, environment }),
    // The legacy provider remains read-only and is deliberate. It retains
    // current Codex compatibility until Codex offers a public local-data API.
    readOnly: true,
    // Electron returns this only for a sandboxed Mac App Store build. Keeping
    // it in the same connection object makes the selected-folder contract
    // portable without treating a plain path as a long-lived entitlement.
    securityScopedBookmark: explicit && typeof source.securityScopedBookmark === "string"
      && source.securityScopedBookmark.length > 0
      ? source.securityScopedBookmark
      : null,
    selectedAt: explicit && Number.isFinite(source.selectedAt)
      ? Math.round(source.selectedAt)
      : null,
    discoverySource: explicit
      ? null
      : (typeof source.discoverySource === "string" && source.discoverySource
        ? source.discoverySource
        : "standard")
  };
}

function codexConnectionPaths(connection) {
  const codexHome = normalizedAbsolutePath(connection?.codexHome);
  if (!codexHome) throw new Error("Codex connection does not have an absolute data folder");
  return {
    codexHome,
    globalStatePath: path.join(codexHome, ".codex-global-state.json"),
    ipcSocketPath: path.join(codexHome, "ipc", "ipc.sock")
  };
}

function isReadableDirectory(directory, accessSync = fs.accessSync) {
  const resolved = normalizedAbsolutePath(directory);
  if (!resolved) return false;
  try {
    accessSync(resolved, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function connectionSummary(connection, {
  locale = "zh-CN",
  accessSync = fs.accessSync,
  fsModule = fs,
  discoveryFailures = 0
} = {}) {
  const normalized = normalizeCodexConnection(connection);
  const readable = isReadableDirectory(normalized.codexHome, accessSync);
  const valid = codexDataFolderEvidence(normalized.codexHome, {
    fsModule
  }).valid;
  const selected = normalized.kind === CONNECTION_KINDS.USER_SELECTED;
  const failures = Math.max(0, Number(discoveryFailures) || 0);
  const manualSelectionAvailable = !valid
    && failures >= AUTO_DISCOVERY_MANUAL_FALLBACK_ATTEMPTS;
  const zh = locale !== "en";
  return {
    ...normalized,
    readable,
    valid,
    title: selected && valid
      ? (zh ? "已手动连接 Codex 数据" : "Codex data connected manually")
      : valid
        ? (zh ? "已自动连接 Codex" : "Codex connected automatically")
        : manualSelectionAvailable
          ? (zh ? "暂未找到 Codex 数据" : "Codex data was not found")
          : (zh ? "正在自动寻找 Codex 数据" : "Looking for Codex data automatically"),
    description: selected && valid
      ? (zh
        ? "当前以只读方式使用手动指定的数据文件夹；不会改动会话或额度数据。"
        : "Uses the manually selected data folder in read-only mode. Sessions and quota data are never changed.")
      : valid
        ? (zh
          ? "已自动找到当前用户的 Codex 数据，无需选择 Codex.app 或安装文件夹。"
          : "Found this user's Codex data automatically. You do not need to locate Codex.app or its installation folder.")
        : manualSelectionAvailable
          ? (zh
            ? "已连续多次检测标准位置仍未找到有效数据。你可以手动指定包含 Codex 数据的文件夹。"
            : "Several automatic attempts found no valid data. You can choose the folder that contains Codex data.")
          : (zh
            ? "应用会持续检测标准数据位置。请先启动一次 Codex；如果多次检测仍失败，才会显示手动选择。"
            : "The app keeps checking standard data locations. Open Codex once; manual selection appears only after repeated failures."),
    discoveryFailures: failures,
    manualSelectionAvailable,
    stable: valid,
    pathLabel: normalized.codexHome
  };
}

function selectedFolderConnection(folder, options = {}) {
  const codexHome = normalizedAbsolutePath(folder);
  if (!codexHome) throw new Error("Select the .codex folder with an absolute path");
  return normalizeCodexConnection({
    kind: CONNECTION_KINDS.USER_SELECTED,
    codexHome,
    securityScopedBookmark: options.securityScopedBookmark,
    selectedAt: options.now ?? Date.now()
  }, options);
}

function defaultCompatibilityConnection(options = {}) {
  return automaticCodexConnection(options);
}

function automaticCodexConnection(options = {}) {
  const discovered = discoverCodexDataHome(options);
  return normalizeCodexConnection({
    kind: CONNECTION_KINDS.AUTO_DISCOVERED,
    codexHome: discovered.codexHome,
    discoverySource: discovered.discoverySource
  }, options);
}

function resolveSelectedCodexFolder(folder, options = {}) {
  const selected = normalizedAbsolutePath(folder);
  if (!selected) return null;
  if (isCodexDataDirectory(selected, options)) return selected;
  const nested = path.join(selected, ".codex");
  return isCodexDataDirectory(nested, options) ? nested : null;
}

module.exports = {
  CODEX_DATA_MARKERS,
  CONNECTION_KINDS,
  CONNECTION_SCHEMA_VERSION,
  AUTO_DISCOVERY_MANUAL_FALLBACK_ATTEMPTS,
  automaticCodexCandidates,
  automaticCodexConnection,
  codexDataFolderEvidence,
  codexConnectionPaths,
  connectionSummary,
  defaultCodexHome,
  defaultCompatibilityConnection,
  discoverCodexDataHome,
  isCodexDataDirectory,
  isReadableDirectory,
  normalizeCodexConnection,
  resolveSelectedCodexFolder,
  selectedFolderConnection
};
