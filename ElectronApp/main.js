"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray
} = require("electron");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  rendererURL, protectRendererWindow, trustedRendererEvent
} = require("./renderer-security");
const { CodexIpcStatusClient } = require("./codex-ipc-status");
const {
  appBundleForExecutable,
  discoverCodexExecutable
} = require("./codex-discovery");
const {
  classifyTask,
  isActiveRuntimeStatus,
  isTopLevelThread
} = require("./task-classification");
const {
  isCodexFrontmost,
  normalizeCompletionNotificationState,
  notificationCopy,
  planCompletionNotifications
} = require("./completion-notifications");
const { evaluateQuotaHealth } = require("./quota-health");
const {
  fetchCodexQuota,
  fetchQuotaWithFallback
} = require("./codex-quota-provider");
const { QuotaDataClient } = require("./quota-data-client");
const {
  SETTINGS_SCHEMA_VERSION,
  editableSettings,
  normalizeSettings
} = require("./settings-store");
const { TaskDataClient } = require("./task-data-client");
const {
  automaticCodexConnection,
  AUTO_DISCOVERY_MANUAL_FALLBACK_ATTEMPTS,
  codexConnectionPaths,
  connectionSummary,
  isCodexDataDirectory,
  normalizeCodexConnection,
  resolveSelectedCodexFolder,
  selectedFolderConnection
} = require("./codex-connection");
const {
  loginItemStatus,
  migrateLegacyLaunchAgent,
  syncLoginItem
} = require("./system-services");
const { BackgroundRecovery } = require("./background-recovery");
const { readFrontmostBundleIdentifier } = require("./frontmost-app");
const {
  createTrayIcon,
  formatTrayQuotaLine,
  formatTrayTaskLine,
  syncTrayQuotaTitle
} = require("./tray-icon");

const HOME = os.homedir();
const SETTINGS_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "codex-companion",
  "settings.json"
);
const SETTINGS_MIGRATION_BACKUP_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "codex-companion",
  "settings-before-schema-5.json"
);
const TRAY_RUNTIME_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "codex-companion",
  `menu-bar-runtime-${process.pid}.json`
);
const COMPLETION_NOTIFICATION_STATE_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "codex-companion",
  "completion-notification-state.json"
);
const RESOURCE_DIAGNOSTICS_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "codex-companion",
  "resource-diagnostics.json"
);
const QUOTA_CACHE_PATH = path.join(
  HOME,
  "Library",
  "Application Support",
  "codex-companion",
  "quota-cache.json"
);
const DOT_SIZE = 44;
const DOT_WINDOW_SIZE = 64;
const DESKTOP_WIDGET_ALWAYS_ON_TOP_LEVEL = "pop-up-menu";
const PANEL_WIDTH = 360;
const PANEL_MAX_HEIGHT = 400;
const PANEL_GAP = 2;
const HOVER_OPEN_MS = 80;
const HOVER_CLOSE_MS = 280;
// Retain one prepared view, not a minute-long warm/cold cache. The existing
// low-frequency resource check may release a hidden view over this soft
// renderer-process budget; no extra polling or pressure helper is needed.
const PANEL_RENDERER_MEMORY_BUDGET_KB = 192 * 1024;
const PANEL_MEMORY_RELEASE_IDLE_MS = 60_000;
const TASK_FALLBACK_REFRESH_MS = 60_000;
const TASK_CHANGE_DEBOUNCE_MS = 300;
const QUOTA_REFRESH_MS = 5 * 60_000;
const QUOTA_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
const CODEX_DISCOVERY_REFRESH_MS = 5 * 60_000;
const RESOURCE_DIAGNOSTICS_MS = 60_000;
const MENU_BAR_HEALTH_MS = 60_000;
const MENU_BAR_RETRY_MAX_MS = 60_000;
const MENU_BAR_PLACEMENT_GRACE_MS = 4_000;
const BACKGROUND_RECOVERY_STABILITY_MS = 30_000;
const ACTIVE_DISCOVERY_WINDOW_MS = 5 * 60_000;
const TRANSCRIPT_RUNNING_MAX_AGE_MS = 24 * 60 * 60_000;
const APP_VERSION = "1.9.13";
const APP_SESSION_STARTED_AT = Date.now();
// Do not reuse the pre-release bundle identities below. macOS 26 Control
// Center persists per-status-item state by bundle identity, including state
// created by the retired native host and diagnostic builds. A final product
// identity gives the single production Tray one clean, stable registration.
// The Application Support path stays unchanged, so existing preferences,
// CodeX connection data and notification state migrate without user action.
const APP_BUNDLE_IDENTIFIER = "com.lindaozhi.codexstatusreminder";
const LEGACY_APP_BUNDLE_IDENTIFIERS = Object.freeze([
  "com.lindaozhi.codexcompanion.app",
  "com.lindaozhi.codexcompanion.desktop",
  "com.lindaozhi.codexcompanion"
]);
// Keep the technical identity stable across upgrades. The localized display
// name is intentionally separate so it can change without losing settings,
// login-item registration, or the menu-bar identity.
const APP_INTERNAL_NAME = "Codex Companion";
const APP_DISPLAY_NAME_ZH = "CodeX状态提醒";
// This application owns exactly one Tray item. Electron's optional macOS GUID
// changes the host identity after AppKit has first announced Item-0. On macOS
// 26 that transition is recorded as two ephemeral hosts, which can leave two
// same-name entries in Menu Bar settings and block both of them. Use the
// documented default single-item slot instead: its identity is the app bundle
// plus its one Tray position, with no post-creation identity migration.
const MENU_BAR_IDENTITY_MODE = "bundle-default-slot-v7";
const MENU_BAR_DISPLAY_EDGE_EPSILON = 2;

// Keep the native process name stable before any AppKit surface is created.
// The signed bundle's CFBundleDisplayName and every renderer/menu label carry
// the localized product name; changing NSApplication's name can make macOS
// reclassify an otherwise stable status-item host.
app.setName(APP_INTERNAL_NAME);
app.setPath(
  "userData",
  path.join(HOME, "Library", "Application Support", "codex-companion")
);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let dotWindow = null;
let panelWindow = null;
let settingsWindow = null;
// Keep one identity-aware entry per unread completion, but render every entry
// inside one shared BrowserWindow. Clicking a card still opens its own task
// without paying one renderer process per persistent banner.
const completionBannerEntries = new Map();
const completionSystemNotifications = new Map();
let completionBannerWindow = null;
let completionBannerExpanded = false;
let menuBarTray = null;
let backgroundRecoveryStableTimer = null;
let menuBarTrayImage = null;
let menuBarTrayIconMode = null;
const menuBarTrayImages = new Map();
let menuBarLayoutTimer = null;
let menuBarLastLeftClickAt = null;
let menuBarLastRightClickAt = null;
let menuBarLastLeftEventAt = 0;
let menuBarLeftEventCount = 0;
let menuBarLeftHandledCount = 0;
let menuBarLastLeftAction = null;
let menuBarCreatedAt = null;
let menuBarCreateCount = 0;
let menuBarRecoveryCount = 0;
let menuBarLastHealthAt = null;
let menuBarLastHealthReason = null;
let menuBarLastError = null;
let menuBarHealthTimer = null;
let menuBarRetryTimer = null;
let menuBarPlacementTimer = null;
let menuBarRetryAttempt = 0;
let quitting = false;
let lastCompletionNotificationStateJSON = null;
let panelDirection = "down";
let panelAnchor = null;
let panelArrowX = PANEL_WIDTH / 2;
let panelReportedHeight = 1;
let panelRendererReady = false;
let panelClockTimer = null;
let panelHiddenSince = null;
let panelSnapshotJSON = null;
let panelPresentationID = 0;
let panelPresentationSentKey = null;
let panelLastFrameLatencyMs = null;
let panelLastRendererMemoryKB = null;
let panelMemoryReleaseCount = 0;
let panelPrewarmCount = 0;
let panelRenderRevision = 0;
let panelRenderedRevision = 0;
let panelOpenStartedAt = null;
let panelLastOpenLatencyMs = null;
let panelLastOpenSource = null;
let panelCreateCount = 0;
let panelReuseCount = 0;
let hoverOpenTimer = null;
let hoverCloseTimer = null;
let codexExecutablePath = null;
let refreshingTasks = false;
let taskRefreshTimer = null;
let taskRefreshQueued = false;
let refreshingQuota = false;
let quotaRefreshQueued = false;
let quotaRefreshDebounceTimer = null;
let lastQuotaSyncAt = null;
let lastQuotaSource = null;
let lastQuotaError = null;
let lastQuotaPrimaryError = null;
let taskDataClient = null;
let quotaDataClient = null;
let taskSourceWatcher = null;
let lastTaskSnapshotJSON = null;
let lastResourceDiagnosticsJSON = null;
let lastResourceDiagnosticsWriteAt = 0;
let lastTaskRefreshDurationMs = null;
let lastTaskQueryMode = null;
let lastTaskChangedRowCount = null;
let lastTranscriptCacheSize = null;
let lastSuccessfulSyncAt = null;
const transcriptWatchers = new Map();
let settings = null;
let codexConnection = null;
let stopSecurityScopedAccess = null;
let completionNotificationState = null;
let lastCompletionNotificationDecision = null;
let runtimeStatusClient = null;
let backgroundRecovery = null;
let snapshot = {
  quota: {
    available: false,
    remainingPercent: null,
    timeRemainingPercent: null,
    resetAt: null,
    health: "neutral",
    healthLabel: "待同步",
    healthDescription: "额度或周期时间暂未同步",
    healthProgress: null
  },
  tasks: [],
  unreadCount: 0,
  runningCount: 0
};

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  fs.renameSync(temporaryPath, filePath);
}

function readSettings() {
  const raw = readJSON(SETTINGS_PATH);
  const normalized = normalizeSettings(raw || {});
  if (
    raw
    && Number(raw.settingsSchemaVersion || 0) < SETTINGS_SCHEMA_VERSION
  ) {
    try {
      if (!fs.existsSync(SETTINGS_MIGRATION_BACKUP_PATH)) {
        writeJSON(SETTINGS_MIGRATION_BACKUP_PATH, raw);
      }
      writeJSON(SETTINGS_PATH, normalized);
    } catch {
      // A failed backup must not prevent the application from starting. The
      // normalized state remains in memory and the next settings write retries.
    }
  }
  return normalized;
}

function persistSettings(next) {
  settings = normalizeSettings(next);
  writeJSON(SETTINGS_PATH, settings);
  return settings;
}

settings = readSettings();

function effectiveLocale(preference = settings?.locale) {
  if (preference === "en" || preference === "zh-CN") return preference;
  const systemLocale = app.isReady()
    ? app.getLocale()
    : Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh(?:[-_]|$)/i.test(systemLocale || "") ? "zh-CN" : "en";
}

function appNameFor(locale = effectiveLocale()) {
  return effectiveLocale(locale) === "en" ? APP_INTERNAL_NAME : APP_DISPLAY_NAME_ZH;
}
const storedCodexConnection = normalizeCodexConnection(settings.codexConnection);
const storedConnectionIsValid = isCodexDataDirectory(storedCodexConnection.codexHome);
codexConnection = storedConnectionIsValid
  ? storedCodexConnection
  : automaticCodexConnection({
    home: HOME,
    previousConnection: storedCodexConnection
  });
const initialConnectionIsValid = isCodexDataDirectory(codexConnection.codexHome);
const initialDiscoveryFailures = initialConnectionIsValid
  ? 0
  : Math.min(
    AUTO_DISCOVERY_MANUAL_FALLBACK_ATTEMPTS,
    settings.codexDiscoveryFailures + 1
  );
if (
  codexConnection.kind !== storedCodexConnection.kind
  || codexConnection.codexHome !== storedCodexConnection.codexHome
  || codexConnection.discoverySource !== storedCodexConnection.discoverySource
  || settings.codexDiscoveryFailures !== initialDiscoveryFailures
) {
  persistSettings({
    ...settings,
    codexConnection,
    codexDiscoveryFailures: initialDiscoveryFailures
  });
}

function activeCodexPaths() {
  return codexConnectionPaths(codexConnection);
}

function applyQuotaRateLimits(rateLimits, {
  source,
  sampledAt = Date.now(),
  persist = false
} = {}) {
  const next = parseQuota({ rateLimits });
  if (
    !next?.available
    || !Number.isFinite(next.resetAt)
    || next.resetAt <= Date.now()
  ) {
    return false;
  }
  snapshot.quota = next;
  lastQuotaSyncAt = sampledAt;
  lastQuotaSource = source || "unknown";
  lastQuotaError = null;
  if (persist) {
    writeJSON(QUOTA_CACHE_PATH, {
      schemaVersion: 1,
      codexHome: codexConnection.codexHome,
      sampledAt,
      source: lastQuotaSource,
      rateLimits
    });
  }
  refreshTrayMenu();
  broadcastSnapshot();
  sendSettingsSnapshot();
  persistResourceDiagnostics({ force: true });
  return true;
}

function restoreCachedQuota() {
  const cached = readJSON(QUOTA_CACHE_PATH);
  const sampledAt = Number(cached?.sampledAt);
  if (
    cached?.schemaVersion !== 1
    || cached.codexHome !== codexConnection.codexHome
    || !Number.isFinite(sampledAt)
    || sampledAt > Date.now()
    || Date.now() - sampledAt > QUOTA_CACHE_MAX_AGE_MS
  ) {
    return false;
  }
  return applyQuotaRateLimits(cached.rateLimits, {
    source: `cache:${cached.source || "unknown"}`,
    sampledAt,
    persist: false
  });
}

async function refreshQuota(reason = "scheduled") {
  if (refreshingQuota) {
    quotaRefreshQueued = true;
    return;
  }
  refreshingQuota = true;
  try {
    const { result, primaryError } = await fetchQuotaWithFallback({
      fetchOfficial: () => ensureQuotaDataClient().refresh(),
      fetchCompatibility: () => fetchCodexQuota({
        codexHome: codexConnection.codexHome,
        fetchImpl: net.fetch.bind(net)
      })
    });
    lastQuotaPrimaryError = primaryError
      ? String(primaryError?.message || primaryError)
      : null;
    applyQuotaRateLimits(result.rateLimits, {
      source: result.source,
      sampledAt: result.fetchedAt,
      persist: true
    });
  } catch (error) {
    if (error?.primaryError) {
      lastQuotaPrimaryError = String(
        error.primaryError?.message || error.primaryError
      );
    }
    lastQuotaError = String(error?.message || error);
    lastQuotaSource = lastQuotaSource || `unavailable:${reason}`;
    persistResourceDiagnostics({ force: true });
  } finally {
    refreshingQuota = false;
    if (quotaRefreshQueued) {
      quotaRefreshQueued = false;
      scheduleQuotaRefresh(0, "queued");
    }
  }
}

function scheduleQuotaRefresh(delay = 0, reason = "change") {
  if (quotaRefreshDebounceTimer) {
    if (delay > 0) return;
    clearTimeout(quotaRefreshDebounceTimer);
  }
  quotaRefreshDebounceTimer = setTimeout(() => {
    quotaRefreshDebounceTimer = null;
    void refreshQuota(reason);
  }, Math.max(0, delay));
  quotaRefreshDebounceTimer.unref?.();
}

function createRuntimeStatusClient() {
  const { ipcSocketPath } = activeCodexPaths();
  return new CodexIpcStatusClient({
    socketPath: ipcSocketPath,
    onStatusChange: () => scheduleTaskRefresh(80, "ipc-status")
  });
}

function activateSelectedFolderAccess() {
  try {
    stopSecurityScopedAccess?.();
  } catch {
  }
  stopSecurityScopedAccess = null;
  const bookmark = codexConnection?.securityScopedBookmark;
  if (
    typeof bookmark !== "string"
    || !bookmark
    || typeof app.startAccessingSecurityScopedResource !== "function"
  ) {
    return;
  }
  try {
    const stop = app.startAccessingSecurityScopedResource(bookmark);
    if (typeof stop === "function") stopSecurityScopedAccess = stop;
  } catch {
    // A bookmark can be unavailable when the app is not a MAS-sandbox build.
    // The selected path remains usable in the regular signed distribution.
  }
}

function syncBackgroundRecovery() {
  if (backgroundRecoveryStableTimer) {
    clearTimeout(backgroundRecoveryStableTimer);
    backgroundRecoveryStableTimer = null;
  }
  if (!backgroundRecovery) {
    backgroundRecovery = new BackgroundRecovery({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData")
    });
  }
  // Recovery is an always-on app reliability mechanism. It only observes this
  // bundle and its own Application Support directory; a deliberate Quit still
  // writes the graceful-exit marker and is never restarted.
  const result = backgroundRecovery.start(true);
  if (result.enabled) {
    backgroundRecoveryStableTimer = setTimeout(() => {
      backgroundRecoveryStableTimer = null;
      backgroundRecovery?.markStableStartup();
    }, BACKGROUND_RECOVERY_STABILITY_MS);
    backgroundRecoveryStableTimer.unref?.();
  }
  return result;
}

runtimeStatusClient = createRuntimeStatusClient();
completionNotificationState = normalizeCompletionNotificationState(
  readJSON(COMPLETION_NOTIFICATION_STATE_PATH) || {}
);
lastCompletionNotificationStateJSON = JSON.stringify(completionNotificationState);

function copyFor(locale = effectiveLocale()) {
  const english = effectiveLocale(locale) === "en";
  return english ? {
    appName: APP_INTERNAL_NAME,
    settings: "Settings…",
    showWidget: "Show desktop widget",
    showMenuBarQuota: "Show weekly quota in menu bar",
    completionNotifications: "Task completion alerts",
    openCodex: "Open Codex",
    quit: `Quit ${APP_INTERNAL_NAME}`,
    trayQuota: "Quota",
    trayReset: "Reset",
    trayTasks: "Tasks",
    quotaRemaining: "Quota remaining",
    timeRemaining: "Time remaining",
    resetCountdown: "Reset in",
    taskProgress: "Task activity",
    unread: "Unread",
    running: "Running",
    completed: "Processed",
    syncing: "Syncing",
    health: {
      healthy: ["Normal", "Quota use is within the selected pace"],
      watch: ["Watch", "Quota use is ahead of the remaining time"],
      critical: ["Quota alert", "Quota use has reached the alert line"],
      neutral: ["Syncing", "Quota or time window is not available yet"]
    }
  } : {
    appName: APP_DISPLAY_NAME_ZH,
    settings: "打开设置…",
    showWidget: "展示桌面小组件",
    showMenuBarQuota: "菜单栏显示剩余周额度",
    completionNotifications: "任务完成提醒",
    openCodex: "打开 Codex",
    quit: `退出 ${APP_DISPLAY_NAME_ZH}`,
    trayQuota: "额度",
    trayReset: "重置",
    trayTasks: "任务",
    quotaRemaining: "额度剩余",
    timeRemaining: "时间剩余",
    resetCountdown: "重置倒计时",
    taskProgress: "任务进展",
    unread: "待查看",
    running: "进行中",
    completed: "已处理",
    syncing: "待同步",
    health: {
      healthy: ["正常使用", "额度消耗仍在设定的正常范围内"],
      watch: ["需留意", "额度消耗已经领先时间进度"],
      critical: ["额度告警", "额度消耗已经达到告警线"],
      neutral: ["待同步", "额度或周期时间暂未同步"]
    }
  };
}

function syncMacLoginItem() {
  // Electron forwards this to the documented macOS login-item service. The
  // preference is tied to the app bundle, so moving the app does not leave a
  // stale hard-coded launchd command behind.
  return syncLoginItem(app, settings);
}

function menuBarStatusSnapshot() {
  const ready = menuBarTrayIsHealthy();
  const bounds = ready ? menuBarTray.getBounds() : null;
  const visible = Boolean(ready && menuBarDisplayForBounds(bounds));
  const display = ready ? displayContainingBounds(bounds) : null;
  const rightGap = display
    ? display.bounds.x + display.bounds.width - bounds.x - bounds.width
    : null;
  const systemHidden = (
    rightGap !== null
    && Math.abs(rightGap) <= MENU_BAR_DISPLAY_EDGE_EPSILON
  );
  return {
    visible,
    state: visible ? "visible" : systemHidden ? "system-hidden" : "unplaced",
    recoveryCount: menuBarRecoveryCount,
    lastError: visible ? null : menuBarLastError
  };
}

function settingsSnapshot() {
  const quota = snapshot.quota;
  const connection = connectionSummary(codexConnection, {
    locale: effectiveLocale(),
    discoveryFailures: settings.codexDiscoveryFailures
  });
  return {
    ...editableSettings(settings),
    version: APP_VERSION,
    effectiveLocale: effectiveLocale(),
    notificationSupported: true,
    notificationDelivery: "in-app-banner",
    menuBarStatus: menuBarStatusSnapshot(),
    codexConnection: {
      ...connection,
      lastSuccessfulSyncAt
    },
    loginItem: loginItemStatus(app),
    quotaHealth: {
      available: quota.available,
      state: quota.health,
      quotaRemainingPercent: quota.remainingPercent,
      timeRemainingPercent: quota.timeRemainingPercent,
      usedPercent: quota.usedPercent,
      timeUsedPercent: Number.isFinite(quota.timeRemainingPercent)
        ? 100 - quota.timeRemainingPercent
        : null,
      windowMinutes: quota.windowMinutes,
      cycleDays: quota.cycleDays,
      elapsedDays: quota.elapsedDays,
      currentDayEnd: quota.currentDayEnd,
      usedEquivalentDays: quota.usedEquivalentDays,
      leadDays: quota.leadDays
    }
  };
}

function quotaHealthCalculationDescription(quota) {
  if (
    !quota.available
    || !Number.isFinite(quota.usedPercent)
    || !Number.isFinite(quota.timeRemainingPercent)
  ) {
    return copyFor().health.neutral[1];
  }
  const leadDays = Math.round(Number(quota.leadDays || 0) * 100) / 100;
  if (effectiveLocale() === "en") {
    return leadDays > 0
      ? `Usage is ${leadDays} quota days ahead of the time pace.`
      : leadDays < 0
        ? `Usage is ${Math.abs(leadDays)} quota days behind the time pace.`
        : "Usage is exactly on the time pace.";
  }
  return leadDays > 0
    ? `当前额度消耗领先时间进度 ${leadDays} 天。`
    : leadDays < 0
      ? `当前额度消耗落后时间进度 ${Math.abs(leadDays)} 天。`
      : "当前额度消耗与时间进度一致。";
}

function sendSettingsSnapshot() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("companion:settings-changed", settingsSnapshot());
  }
}

function initialDotCenter() {
  if (Number.isFinite(settings?.x) && Number.isFinite(settings?.y)) {
    return { x: settings.x, y: settings.y };
  }
  const display = settingsWindow && !settingsWindow.isDestroyed()
    ? screen.getDisplayMatching(settingsWindow.getBounds())
    : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  return {
    x: workArea.x + workArea.width - 72,
    y: workArea.y + Math.round(workArea.height * 0.5)
  };
}

function clampDotCenter(center) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(center.x),
    y: Math.round(center.y)
  });
  const area = display.workArea;
  const margin = 32;
  return {
    x: Math.max(area.x + margin, Math.min(center.x, area.x + area.width - margin)),
    y: Math.max(area.y + margin, Math.min(center.y, area.y + area.height - margin))
  };
}

function reconcileDesktopWidgetPosition({ persist = true } = {}) {
  if (!dotWindow || dotWindow.isDestroyed()) return false;
  const bounds = dotWindow.getBounds();
  const current = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  const next = clampDotCenter(current);
  const moved = Math.abs(next.x - current.x) > 0.5
    || Math.abs(next.y - current.y) > 0.5;
  if (moved) {
    dotWindow.setPosition(
      Math.round(next.x - bounds.width / 2),
      Math.round(next.y - bounds.height / 2),
      false
    );
  }
  if (
    persist
    && (
      moved
      || settings.x !== Math.round(next.x)
      || settings.y !== Math.round(next.y)
    )
  ) {
    persistSettings({
      ...settings,
      x: Math.round(next.x),
      y: Math.round(next.y)
    });
    sendSettingsSnapshot();
  }
  return moved;
}

function handleDisplayLayoutChange() {
  if (!settings.showDesktopWidget) return;
  ensureDesktopWidget();
  reconcileDesktopWidgetPosition();
  if (panelWindow && !panelWindow.isDestroyed()) repositionPanel();
}

function applyWindowPreferences(win) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, DESKTOP_WIDGET_ALWAYS_ON_TOP_LEVEL);
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: false,
    // The bundle is already an LSUIElement accessory. Electron otherwise
    // transforms the process to ForegroundApplication for this call, which
    // can register a Dock tile again when the widget is created or refreshed.
    skipTransformProcessType: true
  });
}

function recoverDotWindow() {
  const previous = dotWindow;
  dotWindow = null;
  if (panelAnchor?.type === "dot") closePanel();
  if (previous && !previous.isDestroyed()) previous.destroy();
  if (settings.showDesktopWidget) {
    setTimeout(() => {
      if (!dotWindow && settings.showDesktopWidget) dotWindow = createDotWindow();
    }, 500).unref();
  }
}

function ensureDesktopWidget() {
  if (!settings.showDesktopWidget) {
    clearHoverOpenTimer();
    if (panelAnchor?.type === "dot") closePanel();
    const previous = dotWindow;
    dotWindow = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
    return;
  }
  if (!dotWindow || dotWindow.isDestroyed()) {
    dotWindow = createDotWindow();
    return;
  }
  applyWindowPreferences(dotWindow);
  dotWindow.showInactive();
  sendDotSnapshot();
}

function createDotWindow() {
  const center = clampDotCenter(initialDotCenter());
  const win = new BrowserWindow({
    width: DOT_WINDOW_SIZE,
    height: DOT_WINDOW_SIZE,
    x: Math.round(center.x - DOT_WINDOW_SIZE / 2),
    y: Math.round(center.y - DOT_WINDOW_SIZE / 2),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-dot.js"),
      sandbox: true,
      contextIsolation: true
    }
  });
  win.setBackgroundColor("#00000000");
  win.setHasShadow(false);
  applyWindowPreferences(win);
  protectRendererWindow(win, rendererURL(__dirname, "dot.html"));
  win.loadFile(path.join(__dirname, "renderer", "dot.html"));
  win.webContents.on("did-finish-load", () => {
    if (settings.showDesktopWidget) win.showInactive();
    sendDotSnapshot();
  });
  win.webContents.once("render-process-gone", () => recoverDotWindow());
  win.on("move", () => {
    if (panelAnchor?.type === "dot") repositionPanel();
  });
  win.on("closed", () => {
    if (dotWindow === win) dotWindow = null;
  });
  return win;
}

function clearHoverOpenTimer() {
  if (hoverOpenTimer !== null) {
    clearTimeout(hoverOpenTimer);
    hoverOpenTimer = null;
  }
}

function clearHoverCloseTimer() {
  if (hoverCloseTimer !== null) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
}

function handleEnter() {
  clearHoverCloseTimer();
  if (!panelAnchor && hoverOpenTimer === null) {
    hoverOpenTimer = setTimeout(() => {
      hoverOpenTimer = null;
      if (!panelAnchor) openPanel({ type: "dot" });
    }, HOVER_OPEN_MS);
  }
}

function windowContainsPoint(win, point) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const bounds = win.getBounds();
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function pointerOverPanelSurface() {
  const point = screen.getCursorScreenPoint();
  return windowContainsPoint(dotWindow, point)
    || windowContainsPoint(panelWindow, point);
}

function handleLeave() {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  hoverCloseTimer = setTimeout(() => {
    hoverCloseTimer = null;
    if (pointerOverPanelSurface()) return;
    closePanel();
  }, HOVER_CLOSE_MS);
}

function estimatedPanelHeight() {
  const rows = Math.min(snapshot.tasks.length, 3);
  if (rows === 0) return 86;
  return Math.min(128 + rows * 88, PANEL_MAX_HEIGHT);
}

function calculatePanelBounds(height, anchor = panelAnchor || { type: "dot" }) {
  if (anchor.type === "tray") {
    const point = anchor.point || screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const x = Math.max(
      area.x,
      Math.min(
        Math.round(point.x - PANEL_WIDTH / 2),
        area.x + area.width - PANEL_WIDTH
      )
    );
    panelArrowX = Math.max(14, Math.min(PANEL_WIDTH - 14, point.x - x));
    return {
      x,
      y: area.y + PANEL_GAP,
      width: PANEL_WIDTH,
      height: Math.min(height, area.height),
      direction: "down"
    };
  }
  if (!dotWindow || dotWindow.isDestroyed()) return null;
  const dotBounds = dotWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: dotBounds.x + dotBounds.width / 2,
    y: dotBounds.y + dotBounds.height / 2
  });
  const area = display.workArea;
  const centerX = dotBounds.x + dotBounds.width / 2;
  const centerY = dotBounds.y + dotBounds.height / 2;
  const dotTop = centerY - DOT_SIZE / 2;
  const dotBottom = centerY + DOT_SIZE / 2;
  const spaceTop = dotTop - area.y;
  const spaceBottom = area.y + area.height - dotBottom;
  const direction = (
    spaceBottom >= height + PANEL_GAP || spaceBottom >= spaceTop
  ) ? "down" : "up";
  const desiredX = Math.round(centerX - PANEL_WIDTH / 2);
  const x = Math.max(
    area.x,
    Math.min(desiredX, area.x + area.width - PANEL_WIDTH)
  );
  const desiredY = direction === "down"
    ? Math.round(dotBottom + PANEL_GAP)
    : Math.round(dotTop - PANEL_GAP - height);
  const y = Math.max(area.y, Math.min(desiredY, area.y + area.height - height));
  panelArrowX = Math.max(14, Math.min(PANEL_WIDTH - 14, centerX - x));
  return { x, y, width: PANEL_WIDTH, height, direction };
}

function preparePanel() {
  if (quitting) return null;
  if (panelWindow && !panelWindow.isDestroyed()) return panelWindow;
  panelRendererReady = false;
  panelSnapshotJSON = null;
  panelHiddenSince = Date.now();
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: estimatedPanelHeight(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    opacity: 0,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-panel.js"),
      sandbox: true,
      contextIsolation: true
    }
  });
  panelWindow = win;
  panelCreateCount += 1;
  applyWindowPreferences(win);
  win.on("blur", () => {
    if (panelWindow === win && panelAnchor) handleLeave();
  });
  win.on("closed", () => {
    if (panelWindow === win) destroyPanel();
  });
  // A failed renderer is discarded, not restarted in a tight recovery loop.
  // The next user open creates a clean renderer without affecting the Tray.
  win.webContents.once("render-process-gone", () => {
    if (panelWindow === win) destroyPanel();
  });
  protectRendererWindow(win, rendererURL(__dirname, "panel.html"));
  win.loadFile(path.join(__dirname, "renderer", "panel.html")).catch(() => {
    if (panelWindow === win) destroyPanel();
  });
  return win;
}

function openPanel(anchor = { type: "dot" }) {
  if (quitting || panelAnchor) return;
  const reusable = Boolean(panelWindow && !panelWindow.isDestroyed());
  const bounds = calculatePanelBounds(
    reusable && panelRendererReady ? panelReportedHeight : estimatedPanelHeight(),
    anchor
  );
  if (!bounds) return;
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  panelAnchor = anchor;
  panelOpenStartedAt = Date.now();
  panelLastOpenSource = anchor.type;
  panelLastFrameLatencyMs = null;
  panelPresentationID += 1;
  panelPresentationSentKey = null;
  panelDirection = bounds.direction;
  if (reusable) panelReuseCount += 1;
  preparePanel();
  panelHiddenSince = null;
  // The prepared view already contains the latest acknowledged data. An
  // unchanged open performs no DOM rebuild or height measurement. If data
  // just changed, its revision must be acknowledged before presentation.
  sendPanelSnapshot();
  presentPreparedPanel();
}

function presentPreparedPanel() {
  if (
    !panelAnchor || !panelRendererReady || !panelWindow
    || panelWindow.isDestroyed() || panelWindow.isVisible()
    || panelRenderRevision === 0 || panelRenderedRevision !== panelRenderRevision
  ) return;
  const bounds = calculatePanelBounds(panelReportedHeight);
  if (!bounds) return;
  panelDirection = bounds.direction;
  const key = `${panelPresentationID}:${panelRenderRevision}`;
  if (panelPresentationSentKey === key) return;
  panelPresentationSentKey = key;
  panelWindow.setBounds(bounds);
  // Only the anchor and entrance effect need a handoff on open. It has no
  // data read or layout measurement and cannot reveal an old data revision.
  panelWindow.webContents.send("companion:panel-present", {
    presentationID: panelPresentationID,
    renderRevision: panelRenderRevision,
    direction: panelDirection,
    arrowX: panelArrowX
  });
}

function showPreparedPanel(message) {
  if (
    !panelAnchor || !panelWindow || panelWindow.isDestroyed()
    || message.presentationID !== panelPresentationID
    || message.renderRevision !== panelRenderRevision
    || panelRenderedRevision !== panelRenderRevision
    || panelWindow.isVisible()
  ) return;
  panelWindow.setOpacity(1);
  panelWindow.showInactive();
  if (panelOpenStartedAt !== null) {
    panelLastOpenLatencyMs = Date.now() - panelOpenStartedAt;
  }
  panelWindow.webContents.send("companion:panel-visibility", {
    visible: true,
    presentationID: panelPresentationID,
    renderRevision: panelRenderRevision,
    requestedAt: panelOpenStartedAt
  });
  panelOpenStartedAt = null;
  writeMenuBarRuntime();
}

function resizePanel(reportedHeight, renderRevision) {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  // Hidden preparation is allowed, but an obsolete reply cannot acknowledge
  // newer data or resurrect a closed panel.
  if (renderRevision !== panelRenderRevision) return;
  if (!Number.isFinite(reportedHeight) || reportedHeight <= 0) return;
  const height = Math.min(
    PANEL_MAX_HEIGHT,
    Math.max(1, Math.ceil(reportedHeight))
  );
  const heightChanged = panelReportedHeight !== height;
  panelReportedHeight = height;
  panelRenderedRevision = renderRevision;
  if (panelAnchor && panelWindow.isVisible() && heightChanged) {
    const previousArrowX = panelArrowX;
    const bounds = calculatePanelBounds(height);
    if (bounds) {
      const directionChanged = panelDirection !== bounds.direction;
      panelDirection = bounds.direction;
      panelWindow.setBounds(bounds);
      if (directionChanged || Math.abs(previousArrowX - panelArrowX) > 0.5) {
        sendPanelPosition();
      }
    }
  }
  presentPreparedPanel();
}

function repositionPanel() {
  if (!panelAnchor || !panelWindow || panelWindow.isDestroyed()) return;
  const previousDirection = panelDirection;
  const previousArrowX = panelArrowX;
  const bounds = calculatePanelBounds(panelReportedHeight);
  if (!bounds) return;
  const directionChanged = previousDirection !== bounds.direction;
  const arrowChanged = Math.abs(previousArrowX - panelArrowX) > 0.5;
  panelDirection = bounds.direction;
  panelWindow.setPosition(bounds.x, bounds.y, false);
  if (directionChanged || arrowChanged) sendPanelPosition();
}

function closePanel() {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  if (!panelWindow || panelWindow.isDestroyed()) {
    destroyPanel();
    return;
  }
  if (!panelAnchor) return;
  panelAnchor = null;
  panelOpenStartedAt = null;
  panelWindow.hide();
  panelWindow.setOpacity(0);
  panelHiddenSince = Date.now();
  panelPresentationSentKey = null;
  panelWindow.webContents.send("companion:panel-visibility", { visible: false });
  // Keep one prepared DOM. Unchanged snapshots do no work, and there is no
  // hidden animation loop. The resource budget can release it when necessary.
  writeMenuBarRuntime();
}

function clearPanelClockTimer() {
  if (panelClockTimer !== null) {
    clearTimeout(panelClockTimer);
    panelClockTimer = null;
  }
}

function destroyPanel() {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  clearPanelClockTimer();
  const win = panelWindow;
  panelWindow = null;
  panelAnchor = null;
  panelRendererReady = false;
  panelSnapshotJSON = null;
  panelHiddenSince = null;
  panelPresentationSentKey = null;
  panelOpenStartedAt = null;
  if (win && !win.isDestroyed()) win.destroy();
  if (!quitting) writeMenuBarRuntime();
}

function checkPreparedPanelMemoryBudget() {
  if (!panelWindow || panelWindow.isDestroyed() || panelAnchor) return;
  try {
    const pid = panelWindow.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((entry) => entry.pid === pid);
    const memoryKB = metric?.memory?.workingSetSize;
    panelLastRendererMemoryKB = Number.isFinite(memoryKB) && memoryKB > 0
      ? memoryKB : null;
    if (
      Number.isFinite(memoryKB) && memoryKB > PANEL_RENDERER_MEMORY_BUDGET_KB
      && panelHiddenSince !== null
      && Date.now() - panelHiddenSince >= PANEL_MEMORY_RELEASE_IDLE_MS
    ) {
      panelMemoryReleaseCount += 1;
      destroyPanel();
    }
  } catch {
    // Unsupported metrics do not mean zero memory or justify retry churn.
    panelLastRendererMemoryKB = null;
  }
}

function panelDiagnostics() {
  const retained = Boolean(panelWindow && !panelWindow.isDestroyed());
  return {
    retained,
    requested: retained && Boolean(panelAnchor),
    visible: retained && panelWindow.isVisible(),
    source: panelAnchor?.type || null,
    rendererReady: retained && panelRendererReady,
    prepared: retained && panelRendererReady
      && panelRenderRevision > 0 && panelRenderRevision === panelRenderedRevision,
    clockUpdatePending: Boolean(panelClockTimer),
    memoryBudgetKB: PANEL_RENDERER_MEMORY_BUDGET_KB,
    rendererMemoryKB: panelLastRendererMemoryKB,
    memoryReleaseCount: panelMemoryReleaseCount,
    prewarmCount: panelPrewarmCount,
    hoverOpenMs: HOVER_OPEN_MS,
    createCount: panelCreateCount,
    reuseCount: panelReuseCount,
    renderRevision: panelRenderRevision,
    renderedRevision: panelRenderedRevision,
    presentationID: panelPresentationID,
    lastFrameLatencyMs: panelLastFrameLatencyMs,
    lastOpenLatencyMs: panelLastOpenLatencyMs,
    lastOpenSource: panelLastOpenSource
  };
}

function createSettingsWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 500,
    minHeight: 640,
    show: false,
    title: copyFor().appName,
    backgroundColor: "#151b1b",
    resizable: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-settings.js"),
      sandbox: true,
      contextIsolation: true
    }
  });
  settingsWindow = win;
  protectRendererWindow(win, rendererURL(__dirname, "settings.html"));
  win.loadFile(path.join(__dirname, "renderer", "settings.html"));
  win.webContents.on("did-finish-load", () => sendSettingsSnapshot());
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  return win;
}

function showSettings() {
  const win = settingsWindow && !settingsWindow.isDestroyed()
    ? settingsWindow
    : createSettingsWindow();
  win.show();
  win.focus();
}

function trayIcon(mode = "full") {
  if (menuBarTrayImages.has(mode)) return menuBarTrayImages.get(mode);
  const image = nativeImage.createFromPath(createTrayIcon(process.resourcesPath, mode));
  if (image.isEmpty()) {
    throw new Error("Codex Companion menu-bar template image is empty");
  }
  image.setTemplateImage(true);
  menuBarTrayImages.set(mode, image);
  return image;
}

function menuBarStatePayload(copy) {
  const quota = snapshot.quota;
  return {
    appName: copy.appName,
    quotaLine: formatTrayQuotaLine({
      locale: effectiveLocale(),
      quotaAvailable: quota.available,
      remainingPercent: quota.remainingPercent,
      resetAt: quota.resetAt
    }),
    taskLine: formatTrayTaskLine({
      locale: effectiveLocale(),
      unreadCount: snapshot.unreadCount,
      runningCount: snapshot.runningCount
    }),
    labels: {
      settings: copy.settings,
      showWidget: copy.showWidget,
      showMenuBarQuota: copy.showMenuBarQuota,
      completionNotifications: copy.completionNotifications,
      openCodex: copy.openCodex,
      quit: copy.quit
    },
    values: {
      showDesktopWidget: settings.showDesktopWidget,
      showMenuBarQuota: settings.showMenuBarQuota,
      notifyOnUnreadCompletion: settings.notifyOnUnreadCompletion
    }
  };
}

function updateMenuBarAppearance() {
  menuBarTray.setToolTip(copyFor().appName);
  const iconMode = settings.showMenuBarQuota ? "quota-star" : "full";
  const iconChanged = menuBarTrayIconMode !== iconMode;
  if (iconChanged) {
    const image = trayIcon(iconMode);
    // Retain the same NSStatusItem and click handlers in both layouts.
    // The narrow, top-aligned star shares the native quota title's row.
    menuBarTray.setImage(image);
    menuBarTrayImage = image;
    menuBarTrayIconMode = iconMode;
  }
  const previousTitle = menuBarTray.getTitle();
  const title = syncTrayQuotaTitle(menuBarTray, {
    showMenuBarQuota: settings.showMenuBarQuota,
    quotaAvailable: snapshot.quota.available,
    remainingPercent: snapshot.quota.remainingPercent,
    resetAt: snapshot.quota.resetAt
  });
  if (iconChanged || title !== previousTitle) {
    clearTimeout(menuBarLayoutTimer);
    // AppKit lays out the status button after its image/title setters return.
    // Re-anchor once after that layout, not against the previous frame.
    menuBarLayoutTimer = setTimeout(() => {
      menuBarLayoutTimer = null;
      if (quitting || !menuBarTray || menuBarTray.isDestroyed()) return;
      if (panelAnchor?.type === "tray") {
        panelAnchor.point = trayAnchorPoint();
        repositionPanel();
      }
      writeMenuBarRuntime();
    }, 50);
    menuBarLayoutTimer.unref();
  }
}

function refreshTrayMenu() {
  if (!ensureMenuBarTray("state-refresh")) return;
  updateMenuBarAppearance();
  writeMenuBarRuntime();
}

function trayAnchorPoint(bounds = menuBarTray?.getBounds()) {
  if (
    !bounds
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return screen.getCursorScreenPoint();
  }
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  };
}

function toggleTrayPanel(bounds) {
  if (panelWindow && panelAnchor?.type === "tray") {
    closePanel();
    return "closed";
  }
  closePanel();
  openPanel({
    type: "tray",
    point: trayAnchorPoint(bounds)
  });
  return "opened";
}

function trayMenuTemplate() {
  const state = menuBarStatePayload(copyFor());
  const toggle = (label, key, checked, enabled = true) => ({
    label,
    type: "checkbox",
    checked,
    enabled,
    click: (item) => {
      void updateSettings({ [key]: item.checked });
    }
  });
  return [
    { label: state.appName, enabled: false },
    { label: state.quotaLine, enabled: false },
    { label: state.taskLine, enabled: false },
    { type: "separator" },
    toggle(
      state.labels.showMenuBarQuota,
      "showMenuBarQuota",
      state.values.showMenuBarQuota
    ),
    toggle(
      state.labels.showWidget,
      "showDesktopWidget",
      state.values.showDesktopWidget
    ),
    toggle(
      state.labels.completionNotifications,
      "notifyOnUnreadCompletion",
      state.values.notifyOnUnreadCompletion
    ),
    { type: "separator" },
    { label: state.labels.settings, click: showSettings },
    { label: state.labels.openCodex, click: openCodex },
    { label: state.labels.quit, click: () => app.quit() }
  ];
}

function horizontalIntersectionWidth(first, second) {
  return Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width)
      - Math.max(first.x, second.x)
  );
}

function verticalIntersectionHeight(first, second) {
  return Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height)
      - Math.max(first.y, second.y)
  );
}

function displayContainingBounds(bounds) {
  if (
    !bounds
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return null;
  }
  return screen.getAllDisplays().find((display) => (
    horizontalIntersectionWidth(bounds, display.bounds) > 0
    && verticalIntersectionHeight(bounds, display.bounds) > 0
  )) || null;
}

function menuBarDisplayForBounds(bounds) {
  if (
    !bounds
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return null;
  }
  return screen.getAllDisplays().find((display) => {
    const horizontalCoverage = (
      horizontalIntersectionWidth(bounds, display.bounds) / bounds.width
    );
    const verticalCoverage = (
      verticalIntersectionHeight(bounds, display.bounds) / bounds.height
    );
    const topInset = Math.max(
      0,
      display.workArea.y - display.bounds.y
    );
    const menuBarBandHeight = Math.max(44, Math.min(72, topInset + 10));
    const displayRightEdge = display.bounds.x + display.bounds.width;
    const trayRightEdge = bounds.x + bounds.width;
    // macOS 26 keeps blocked NSStatusItems alive at a sentinel position flush
    // with the display's right edge. That rectangle intersects the display and
    // sits in the menu-bar band, but it is not visible to the user.
    const hiddenAtDisplayEdge = (
      Math.abs(displayRightEdge - trayRightEdge)
        <= MENU_BAR_DISPLAY_EDGE_EPSILON
    );
    return (
      horizontalCoverage >= 0.75
      && verticalCoverage >= 0.75
      && bounds.y >= display.bounds.y - 2
      && bounds.y + bounds.height <= (
        display.bounds.y + menuBarBandHeight + 2
      )
      && !hiddenAtDisplayEdge
    );
  }) || null;
}

function writeMenuBarRuntime() {
  if (!menuBarTray || menuBarTray.isDestroyed()) return;
  const bounds = menuBarTray.getBounds();
  const intersectingDisplay = displayContainingBounds(bounds);
  const menuBarDisplay = menuBarDisplayForBounds(bounds);
  const trayRightEdgeGap = intersectingDisplay
    ? (
        intersectingDisplay.bounds.x
        + intersectingDisplay.bounds.width
        - bounds.x
        - bounds.width
      )
    : null;
  const trayTouchesDisplayRightEdge = (
    trayRightEdgeGap !== null
    && Math.abs(trayRightEdgeGap) <= MENU_BAR_DISPLAY_EDGE_EPSILON
  );
  writeJSON(TRAY_RUNTIME_PATH, {
    menuBarImplementation: "electron-main-tray",
    menuBarIdentityMode: MENU_BAR_IDENTITY_MODE,
    pid: process.pid,
    displayName: copyFor().appName,
    bundleIdentifier: APP_BUNDLE_IDENTIFIER,
    guid: menuBarTray.getGUID(),
    traySlot: "default-0",
    autoRecreateOnPlacementFailure: false,
    trayDestroyed: menuBarTray.isDestroyed(),
    trayBounds: bounds,
    trayBoundsVisible: Boolean(intersectingDisplay),
    trayBoundsInMenuBar: Boolean(menuBarDisplay),
    trayPlacementState: menuBarDisplay
      ? "visible"
      : trayTouchesDisplayRightEdge ? "system-hidden" : "unplaced",
    trayRightEdgeGap,
    trayTouchesDisplayRightEdge,
    trayDisplay: menuBarDisplay ? {
      id: menuBarDisplay.id,
      bounds: menuBarDisplay.bounds,
      workArea: menuBarDisplay.workArea,
      scaleFactor: menuBarDisplay.scaleFactor
    } : null,
    intersectingDisplay: intersectingDisplay ? {
      id: intersectingDisplay.id,
      bounds: intersectingDisplay.bounds,
      workArea: intersectingDisplay.workArea,
      scaleFactor: intersectingDisplay.scaleFactor
    } : null,
    imageEmpty: menuBarTrayImage?.isEmpty() ?? true,
    imageTemplate: menuBarTrayImage?.isTemplateImage() ?? false,
    imageLogicalSize: menuBarTrayImage?.getSize() ?? null,
    imageScaleFactors: menuBarTrayImage?.getScaleFactors() ?? [],
    iconMode: menuBarTrayIconMode,
    layoutPending: Boolean(menuBarLayoutTimer),
    trayTitle: menuBarTray.getTitle(),
    showMenuBarQuota: settings.showMenuBarQuota,
    weeklyQuotaAvailable: snapshot.quota.available,
    weeklyQuotaRemainingPercent: snapshot.quota.remainingPercent,
    weeklyQuotaResetAt: snapshot.quota.resetAt,
    trayCreatedAt: menuBarCreatedAt,
    trayCreateCount: menuBarCreateCount,
    trayRecoveryCount: menuBarRecoveryCount,
    lastHealthAt: menuBarLastHealthAt,
    lastHealthReason: menuBarLastHealthReason,
    lastError: menuBarLastError,
    lastLeftClickAt: menuBarLastLeftClickAt,
    lastRightClickAt: menuBarLastRightClickAt,
    leftClickEventCount: menuBarLeftEventCount,
    leftClickHandledCount: menuBarLeftHandledCount,
    lastLeftAction: menuBarLastLeftAction,
    taskPanel: panelDiagnostics(),
    updatedAt: Date.now()
  });
}

function createMenuBarTray() {
  if (menuBarTray && !menuBarTray.isDestroyed()) return menuBarTray;
  menuBarTrayIconMode = settings.showMenuBarQuota ? "quota-star" : "full";
  menuBarTrayImage = trayIcon(menuBarTrayIconMode);
  // Do not pass a custom GUID. With one Tray, Electron's default macOS slot
  // is the normal application contract and does not perform a second host-ID
  // registration after the item first appears.
  menuBarTray = new Tray(menuBarTrayImage);
  menuBarCreatedAt = Date.now();
  menuBarCreateCount += 1;
  updateMenuBarAppearance();
  menuBarTray.setIgnoreDoubleClickEvents(true);
  menuBarTray.on("click", (_event, bounds) => {
    const now = Date.now();
    menuBarLeftEventCount += 1;
    if (now - menuBarLastLeftEventAt < 250) {
      writeMenuBarRuntime();
      return;
    }
    menuBarLastLeftEventAt = now;
    menuBarLastLeftClickAt = now;
    menuBarLeftHandledCount += 1;
    menuBarLastLeftAction = toggleTrayPanel(bounds);
    writeMenuBarRuntime();
  });
  menuBarTray.on("right-click", () => {
    menuBarLastRightClickAt = Date.now();
    closePanel();
    writeMenuBarRuntime();
    menuBarTray.popUpContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  });
  writeMenuBarRuntime();
  scheduleMenuBarPlacementValidation("tray-created");
  return menuBarTray;
}

function menuBarTrayIsHealthy() {
  return Boolean(
    menuBarTray
      && !menuBarTray.isDestroyed()
      && menuBarTrayImage
      && !menuBarTrayImage.isEmpty()
      && menuBarTrayImage.isTemplateImage()
  );
}

function clearMenuBarRetryTimer() {
  if (!menuBarRetryTimer) return;
  clearTimeout(menuBarRetryTimer);
  menuBarRetryTimer = null;
}

function clearMenuBarPlacementTimer() {
  if (!menuBarPlacementTimer) return;
  clearTimeout(menuBarPlacementTimer);
  menuBarPlacementTimer = null;
}

function scheduleMenuBarPlacementValidation(reason) {
  if (quitting || menuBarPlacementTimer) return;
  menuBarPlacementTimer = setTimeout(() => {
    menuBarPlacementTimer = null;
    if (!menuBarTrayIsHealthy()) {
      ensureMenuBarTray(`placement-object:${reason}`);
      return;
    }
    const bounds = menuBarTray.getBounds();
    if (menuBarDisplayForBounds(bounds)) {
      const recovered = Boolean(menuBarLastError);
      if (
        menuBarLastError?.startsWith("tray-not-in-menu-bar:")
        || menuBarLastError?.startsWith("tray-system-hidden:")
      ) {
        menuBarLastError = null;
      }
      writeMenuBarRuntime();
      if (recovered) sendSettingsSnapshot();
      return;
    }

    const intersectingDisplay = displayContainingBounds(bounds);
    const trayRightEdgeGap = intersectingDisplay
      ? (
          intersectingDisplay.bounds.x
          + intersectingDisplay.bounds.width
          - bounds.x
          - bounds.width
        )
      : null;
    if (
      trayRightEdgeGap !== null
      && Math.abs(trayRightEdgeGap) <= MENU_BAR_DISPLAY_EDGE_EPSILON
    ) {
      // A blocked item remains a healthy NSStatusItem object. Recreating it
      // only produces another host and makes macOS retain duplicate entries.
      // Preserve this single object, report the real system-hidden state, and
      // let the normal lifecycle checks observe a later public settings change.
      menuBarLastError = `tray-system-hidden:${JSON.stringify(bounds)}`;
      writeMenuBarRuntime();
      sendSettingsSnapshot();
      return;
    }

    menuBarLastError = `tray-not-in-menu-bar:${JSON.stringify(bounds)}`;
    writeMenuBarRuntime();
    // Placement is owned by macOS. A live Tray object must never be destroyed
    // merely because the system has not placed it yet; doing so is precisely
    // what creates duplicate menu-bar hosts on later macOS releases.
    sendSettingsSnapshot();
  }, MENU_BAR_PLACEMENT_GRACE_MS);
  menuBarPlacementTimer.unref();
}

function destroyMenuBarTray() {
  clearMenuBarPlacementTimer();
  if (menuBarTray && !menuBarTray.isDestroyed()) {
    try {
      menuBarTray.destroy();
    } catch {
    }
  }
  menuBarTray = null;
  menuBarTrayImage = null;
}

function scheduleMenuBarRetry(reason) {
  if (quitting || menuBarRetryTimer) return;
  const delay = Math.min(
    MENU_BAR_RETRY_MAX_MS,
    1_000 * (2 ** Math.min(menuBarRetryAttempt, 6))
  );
  menuBarRetryAttempt += 1;
  menuBarRetryTimer = setTimeout(() => {
    menuBarRetryTimer = null;
    ensureMenuBarTray(`retry:${reason}`);
  }, delay);
  menuBarRetryTimer.unref();
}

function ensureMenuBarTray(reason = "health-check") {
  if (quitting || !app.isReady()) return null;
  menuBarLastHealthAt = Date.now();
  menuBarLastHealthReason = reason;
  if (menuBarTrayIsHealthy()) {
    menuBarRetryAttempt = 0;
    clearMenuBarRetryTimer();
    writeMenuBarRuntime();
    scheduleMenuBarPlacementValidation(reason);
    return menuBarTray;
  }

  const recovering = menuBarCreateCount > 0;
  destroyMenuBarTray();

  try {
    createMenuBarTray();
    if (recovering) menuBarRecoveryCount += 1;
    menuBarLastError = null;
    menuBarRetryAttempt = 0;
    clearMenuBarRetryTimer();
    writeMenuBarRuntime();
    return menuBarTray;
  } catch (error) {
    menuBarLastError = String(error?.message || error);
    scheduleMenuBarRetry(reason);
    return null;
  }
}

function startMenuBarLifecycleMonitoring() {
  if (menuBarHealthTimer) return;
  const recheck = (reason, delay = 0) => {
    const timer = setTimeout(() => ensureMenuBarTray(reason), delay);
    timer.unref();
  };
  const recheckAfterWake = (reason) => {
    recheck(reason, 250);
    scheduleQuotaRefresh(500, reason);
  };
  powerMonitor.on("resume", () => recheckAfterWake("system-resume"));
  powerMonitor.on("unlock-screen", () => recheckAfterWake("screen-unlock"));
  powerMonitor.on(
    "user-did-become-active",
    () => recheck("login-session-active", 250)
  );
  menuBarHealthTimer = setInterval(
    () => ensureMenuBarTray("periodic-health"),
    MENU_BAR_HEALTH_MS
  );
  menuBarHealthTimer.unref();
}

async function openMenuBarSystemSettings() {
  try {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.ControlCenter-Settings.extension"
    );
    return { opened: true };
  } catch {
    const error = await shell.openPath("/System/Applications/System Settings.app");
    return { opened: error === "", error: error || null };
  }
}

function menuCommandFromArguments(arguments_) {
  const index = arguments_.indexOf("--menu-command");
  return index >= 0 && typeof arguments_[index + 1] === "string"
    ? arguments_[index + 1]
    : null;
}

function handleMenuCommand(command) {
  if (!command) return false;
  if (command === "show-panel") {
    toggleTrayPanel();
    return true;
  }
  if (command === "show-tray-summary") {
    showSettings();
    return true;
  }
  if (command === "hide-panel") {
    handleLeave();
    return true;
  }
  if (command === "show-settings") {
    closePanel();
    showSettings();
    return true;
  }
  if (command === "open-codex") {
    openCodex();
    return true;
  }
  if (command === "quit") {
    app.quit();
    return true;
  }
  const match = /^set:([A-Za-z]+):(.+)$/.exec(command);
  if (!match) return false;
  const [, key, encodedValue] = match;
  const booleanKeys = new Set([
    "showDesktopWidget",
    "showMenuBarQuota",
    "notifyOnUnreadCompletion",
    "launchAtBoot",
    "launchAtLogin"
  ]);
  const value = booleanKeys.has(key)
    ? encodedValue === "true"
    : encodedValue;
  const currentKey = key === "launchAtBoot"
    ? "launchAtLogin"
    : key;
  void updateSettings({ [currentKey]: value });
  return true;
}

function applyCodexConnection(nextConnection, { forceRefresh = false } = {}) {
  const next = normalizeCodexConnection(nextConnection);
  const nextIsValid = isCodexDataDirectory(next.codexHome);
  const nextDiscoveryFailures = nextIsValid
    ? 0
    : Math.min(
      AUTO_DISCOVERY_MANUAL_FALLBACK_ATTEMPTS,
      settings.codexDiscoveryFailures + 1
    );
  const changed = next.kind !== codexConnection.kind
    || next.codexHome !== codexConnection.codexHome
    || next.discoverySource !== codexConnection.discoverySource;
  if (!changed) {
    if (forceRefresh) {
      if (settings.codexDiscoveryFailures !== nextDiscoveryFailures) {
        persistSettings({
          ...settings,
          codexDiscoveryFailures: nextDiscoveryFailures
        });
      }
      startTaskSourceWatcher();
      scheduleTaskRefresh(0, "connection-recheck");
      scheduleQuotaRefresh(0, "connection-recheck");
      sendSettingsSnapshot();
    }
    return settingsSnapshot();
  }

  // Rebuild only the readers attached to the previous selected folder. The
  // visual state remains until the new source returns a fresh snapshot, so
  // changing a folder never makes the widget briefly look like it has no
  // tasks or quota.
  stopTaskSourceWatchers();
  taskDataClient?.stop();
  taskDataClient = null;
  quotaDataClient?.stop();
  quotaDataClient = null;
  runtimeStatusClient?.stop();
  codexExecutablePath = null;
  codexConnection = next;
  persistSettings({
    ...settings,
    codexConnection: next,
    codexDiscoveryFailures: nextDiscoveryFailures
  });
  activateSelectedFolderAccess();
  runtimeStatusClient = createRuntimeStatusClient();
  startTaskSourceWatcher();
  scheduleTaskRefresh(0, "connection-changed");
  scheduleQuotaRefresh(0, "connection-changed");
  refreshTrayMenu();
  sendSettingsSnapshot();
  return settingsSnapshot();
}

async function chooseCodexDataFolder() {
  const options = {
    title: effectiveLocale() === "en"
      ? "Choose Codex data folder"
      : "选择 Codex 数据文件夹",
    defaultPath: codexConnection.codexHome,
    properties: ["openDirectory"],
    // Electron returns a bookmark only from a sandboxed MAS build. The same
    // picker keeps this connection ready for that normal permission model
    // while the signed desktop build continues to work without it.
    securityScopedBookmarks: true
  };
  const result = settingsWindow && !settingsWindow.isDestroyed()
    ? await dialog.showOpenDialog(settingsWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths?.[0]) return settingsSnapshot();
  const resolvedFolder = resolveSelectedCodexFolder(result.filePaths[0]);
  if (!resolvedFolder) {
    const message = effectiveLocale() === "en"
      ? {
        type: "warning",
        title: "This is not a Codex data folder",
        message: "No Codex task data was found in the selected folder.",
        detail: "Choose the folder that contains state_*.sqlite or .codex-global-state.json. In most cases you do not need to choose anything—use automatic detection instead.",
        buttons: ["OK"]
      }
      : {
        type: "warning",
        title: "这不是 Codex 数据文件夹",
        message: "所选文件夹中没有找到 Codex 任务数据。",
        detail: "请选择包含 state_*.sqlite 或 .codex-global-state.json 的文件夹。通常无需手动选择，使用自动检测即可。",
        buttons: ["知道了"]
      };
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      await dialog.showMessageBox(settingsWindow, message);
    } else {
      await dialog.showMessageBox(message);
    }
    return settingsSnapshot();
  }
  return applyCodexConnection(selectedFolderConnection(resolvedFolder, {
    securityScopedBookmark: result.bookmarks?.[0] || null
  }));
}

function redetectCodexConnection() {
  return applyCodexConnection(automaticCodexConnection({
    home: HOME,
    previousConnection: codexConnection
  }), {
    forceRefresh: true
  });
}

function recoverAutomaticCodexConnection() {
  if (isCodexDataDirectory(codexConnection.codexHome)) {
    if (!taskSourceWatcher) {
      startTaskSourceWatcher();
      scheduleTaskRefresh(0, "connection-became-available");
      scheduleQuotaRefresh(0, "connection-became-available");
      sendSettingsSnapshot();
      return true;
    }
    return false;
  }
  // A stale manually selected path must not block a portable install from
  // finding the new computer's standard Codex data location.
  applyCodexConnection(automaticCodexConnection({
    home: HOME,
    previousConnection: codexConnection
  }), {
    forceRefresh: true
  });
  return true;
}

function updateSettings(patch) {
  const allowed = [
    "locale",
    "showDesktopWidget",
    "showMenuBarQuota",
    "notifyOnUnreadCompletion",
    "quotaHealthMode",
    "quotaHealthyLeadDays",
    "quotaWarningLeadDays",
    "launchAtLogin",
    "onboardingCompleted"
  ];
  const update = {};
  for (const key of allowed) {
    if (Object.hasOwn(patch || {}, key)) update[key] = patch[key];
  }
  const previous = settings;
  persistSettings({ ...settings, ...update });
  const startupChanged = previous.launchAtLogin !== settings.launchAtLogin;
  const healthThresholdsChanged = (
    previous.quotaHealthMode !== settings.quotaHealthMode
    || previous.quotaHealthyLeadDays !== settings.quotaHealthyLeadDays
    || previous.quotaWarningLeadDays !== settings.quotaWarningLeadDays
  );
  const localeChanged = previous.locale !== settings.locale;
  const notificationsChanged = (
    previous.notifyOnUnreadCompletion !== settings.notifyOnUnreadCompletion
  );
  if (startupChanged) {
    syncMacLoginItem();
    syncBackgroundRecovery();
  }
  if (notificationsChanged && !settings.notifyOnUnreadCompletion) {
    persistCompletionNotificationState(planCompletionNotifications({
      tasks: [], state: completionNotificationState, enabled: false
    }).state);
    closeAllCompletionBanners();
  }
  if (localeChanged) {
    const appName = copyFor().appName;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setTitle(appName);
    }
  }
  if (dotWindow && !dotWindow.isDestroyed()) applyWindowPreferences(dotWindow);
  if (panelWindow && !panelWindow.isDestroyed()) applyWindowPreferences(panelWindow);
  if (healthThresholdsChanged) refreshSnapshotQuotaHealth();
  ensureDesktopWidget();
  refreshTrayMenu();
  sendSettingsSnapshot();
  broadcastSnapshot();
  if (localeChanged) sendCompletionBannerContent();
  return { settings: settingsSnapshot(), startupChanged };
}

function cleanDisplayText(value, cwd = "") {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cwd) text = text.split(cwd).join("").trim();
  return text.replace(/^[\s:：—–-]+/, "").trim();
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1_000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function discoveredCodexBundleIdentifiers() {
  const executable = resolveCodexExecutable();
  const bundlePath = appBundleForExecutable(executable);
  if (!bundlePath) return [];
  try {
    const identifier = childProcess.execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", path.join(bundlePath, "Contents", "Info.plist")],
      { encoding: "utf8", timeout: 2_000 }
    ).trim();
    return identifier ? [identifier] : [];
  } catch {
    return [];
  }
}

function persistCompletionNotificationState(next) {
  const serialized = JSON.stringify(next);
  if (serialized === lastCompletionNotificationStateJSON) return;
  writeJSON(COMPLETION_NOTIFICATION_STATE_PATH, next);
  completionNotificationState = next;
  lastCompletionNotificationStateJSON = serialized;
}

function openTask(threadID) {
  if (typeof threadID !== "string" || !threadID) {
    openCodex();
    return;
  }
  dismissCompletionBanner(threadID);
  void shell.openExternal(`codex://threads/${encodeURIComponent(threadID)}`)
    .catch(() => openCodex());
}

const COMPLETION_BANNER_MARGIN = 16;
const COMPLETION_BANNER_WIDTH = 440;
const COMPLETION_BANNER_ROW_HEIGHT = 104;
const COMPLETION_BANNER_STACK_LAYER_HEIGHT = 12;
const COMPLETION_BANNER_MAX_COLLAPSED_LAYERS = 2;
// 20px vertical padding + 2px borders + 26px header + 8px gap.
// Include the whole fixed area so three rows do not lose their bottom edge.
const COMPLETION_BANNER_EXPANDED_HEADER_HEIGHT = 56;
const COMPLETION_BANNER_EXPANDED_ROW_HEIGHT = 64;
const COMPLETION_BANNER_EXPANDED_ROW_GAP = 6;
const COMPLETION_BANNER_MAX_VISIBLE_ROWS = 3;

function completionEntryTimestamp(entry) {
  const completedAt = Number(entry?.content?.completedAt);
  if (Number.isFinite(completedAt) && completedAt > 0) return completedAt;
  const createdAt = Number(entry?.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function sortCompletionEntries(entries) {
  return [...entries].sort((a, b) => {
    const timestampDifference = (
      completionEntryTimestamp(b) - completionEntryTimestamp(a)
    );
    if (timestampDifference !== 0) return timestampDifference;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

function completionBannerExpandedContentHeight(entryCount) {
  const visibleRows = Math.min(
    COMPLETION_BANNER_MAX_VISIBLE_ROWS,
    Math.max(1, entryCount)
  );
  return COMPLETION_BANNER_EXPANDED_HEADER_HEIGHT
    + visibleRows * COMPLETION_BANNER_EXPANDED_ROW_HEIGHT
    + Math.max(0, visibleRows - 1) * COMPLETION_BANNER_EXPANDED_ROW_GAP;
}

function completionBannerLayout(entryCount) {
  const isExpanded = completionBannerExpanded && entryCount > 1;
  const collapsedLayers = Math.min(
    COMPLETION_BANNER_MAX_COLLAPSED_LAYERS,
    Math.max(0, entryCount - 1)
  );
  const contentHeight = isExpanded
    ? completionBannerExpandedContentHeight(entryCount)
    : COMPLETION_BANNER_ROW_HEIGHT
      + collapsedLayers * COMPLETION_BANNER_STACK_LAYER_HEIGHT;
  return {
    isExpanded,
    collapsedLayers,
    contentHeight,
    windowHeight: 16 + contentHeight
  };
}

function removePendingCompletion(threadID) {
  if (
    !completionNotificationState
    || !Object.hasOwn(completionNotificationState.pending || {}, threadID)
  ) {
    return;
  }
  const pending = { ...completionNotificationState.pending };
  delete pending[threadID];
  persistCompletionNotificationState({
    ...completionNotificationState,
    version: 3,
    pending,
    updatedAt: Date.now()
  });
}

function positionCompletionBanners() {
  if (!completionBannerWindow || completionBannerWindow.isDestroyed()) return;
  const entries = sortCompletionEntries(completionBannerEntries.values());
  if (entries.length === 0) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const availableHeight = Math.max(
    COMPLETION_BANNER_ROW_HEIGHT,
    area.height - COMPLETION_BANNER_MARGIN * 2
  );
  const layout = completionBannerLayout(entries.length);
  const height = Math.min(availableHeight, layout.windowHeight);
  completionBannerWindow.setBounds({
    x: Math.round(
      area.x + area.width - COMPLETION_BANNER_WIDTH - COMPLETION_BANNER_MARGIN
    ),
    y: Math.round(area.y + COMPLETION_BANNER_MARGIN),
    width: COMPLETION_BANNER_WIDTH,
    height
  });
}

function sendCompletionBannerContent() {
  if (!completionBannerWindow || completionBannerWindow.isDestroyed()) return;
  const items = sortCompletionEntries(completionBannerEntries.values())
    .map((entry) => ({
      threadID: entry.threadID,
      title: entry.content.title,
      body: entry.content.body.slice(0, 320),
      closeLabel: effectiveLocale() === "en"
        ? "Close notification"
        : "关闭通知",
      appName: copyFor().appName
    }));
  const layout = completionBannerLayout(items.length);
  completionBannerWindow.webContents.send(
    "companion:notification-content",
    {
      items,
      expanded: layout.isExpanded,
      collapsedLayers: layout.collapsedLayers,
      expandedContentHeight: layout.contentHeight,
      locale: effectiveLocale()
    }
  );
}

function closeCompletionBanner(threadID, { clearPending = false } = {}) {
  completionBannerEntries.delete(threadID);
  if (completionBannerEntries.size <= 1) completionBannerExpanded = false;
  if (clearPending) removePendingCompletion(threadID);
  const systemNotification = completionSystemNotifications.get(threadID);
  if (systemNotification) {
    completionSystemNotifications.delete(threadID);
    try {
      systemNotification.close();
    } catch {
    }
  }
  if (completionBannerEntries.size === 0) {
    const window = completionBannerWindow;
    completionBannerWindow = null;
    if (window && !window.isDestroyed()) window.destroy();
  } else {
    sendCompletionBannerContent();
    positionCompletionBanners();
  }
}

function dismissCompletionBanner(threadID) {
  if (typeof threadID !== "string" || !threadID) return;
  closeCompletionBanner(threadID, { clearPending: true });
}

function closeAllCompletionBanners() {
  completionBannerEntries.clear();
  completionBannerExpanded = false;
  const window = completionBannerWindow;
  completionBannerWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
  for (const notification of completionSystemNotifications.values()) {
    try {
      notification.close();
    } catch {
    }
  }
  completionSystemNotifications.clear();
}

function showSystemNotificationFallback(content) {
  if (!Notification.isSupported()) return;
  try {
    const previous = completionSystemNotifications.get(content.threadID);
    if (previous) {
      try {
        previous.close();
      } catch {
      }
    }
    const notification = new Notification({
      title: content.title,
      body: content.body.slice(0, 320),
      silent: false,
      timeoutType: "never"
    });
    completionSystemNotifications.set(content.threadID, notification);
    notification.on("click", () => openTask(content.threadID));
    notification.on("close", () => {
      if (completionSystemNotifications.get(content.threadID) === notification) {
        completionSystemNotifications.delete(content.threadID);
      }
    });
    notification.show();
  } catch {
  }
}

function ensureCompletionBannerWindow() {
  if (completionBannerWindow && !completionBannerWindow.isDestroyed()) {
    return completionBannerWindow;
  }
  try {
    const win = new BrowserWindow({
      width: COMPLETION_BANNER_WIDTH,
      height: 112,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      type: "panel",
      webPreferences: {
        preload: path.join(__dirname, "preload-notification.js"),
      sandbox: true,
        contextIsolation: true
      }
    });
    // Electron's transparent panel can otherwise retain a native shadow or
    // stale backing color around the four rounded corners on some macOS
    // releases. Explicitly clear both after creation as well as in CSS.
    if (typeof win.setBackgroundColor === "function") {
      win.setBackgroundColor("#00000000");
    }
    if (typeof win.setHasShadow === "function") {
      win.setHasShadow(false);
    }
    completionBannerWindow = win;
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // Keep completion banners as accessory-owned panels; do not let
      // Electron promote the process (and its Dock tile) while showing one.
      skipTransformProcessType: true
    });
    protectRendererWindow(win, rendererURL(__dirname, "notification.html"));
    void win.loadFile(path.join(__dirname, "renderer", "notification.html"))
      .catch(() => {
        console.error("Codex Companion completion banner renderer failed to load");
        if (completionBannerWindow === win) {
          completionBannerWindow = null;
          if (!win.isDestroyed()) win.destroy();
          for (const entry of completionBannerEntries.values()) {
            showSystemNotificationFallback(entry.content);
          }
        }
      });
    win.webContents.on("did-finish-load", () => {
      sendCompletionBannerContent();
      positionCompletionBanners();
      if (!win.isDestroyed()) win.showInactive();
    });
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        "Codex Companion completion banner did-fail-load",
        errorCode,
        errorDescription,
        validatedURL
      );
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("Codex Companion completion banner renderer gone", details);
    });
  win.on("closed", () => {
      if (completionBannerWindow === win) {
        completionBannerWindow = null;
        completionBannerExpanded = false;
      }
    });
    return win;
  } catch (error) {
    console.error("Codex Companion completion banner window failed", error);
    return null;
  }
}

function showCompletionNotification(content) {
  if (!content?.threadID) return;
  const existing = completionBannerEntries.get(content.threadID);
  completionBannerEntries.set(content.threadID, {
    threadID: content.threadID,
    content,
    preview: content.preview === true,
    createdAt: existing?.createdAt || Date.now()
  });
  const win = ensureCompletionBannerWindow();
  if (!win) {
    showSystemNotificationFallback(content);
    return Notification.isSupported() ? "system-notification" : "unavailable";
  }
  sendCompletionBannerContent();
  positionCompletionBanners();
  win.showInactive();
  return "in-app-banner";
}

function syncCompletionBanners(tasks, plannedState) {
  const pending = plannedState?.pending || {};
  for (const threadID of [...completionBannerEntries.keys()]) {
    const entry = completionBannerEntries.get(threadID);
    if (!entry?.preview && !Object.hasOwn(pending, threadID)) {
      closeCompletionBanner(threadID);
    }
  }
  const taskByID = new Map(
    tasks.filter((task) => task?.id).map((task) => [task.id, task])
  );
  for (const [threadID, completedAt] of Object.entries(pending)) {
    const task = taskByID.get(threadID);
    if (!task || task.state !== "unread") continue;
    showCompletionNotification({
      threadID,
      completedAt,
      ...notificationCopy(task, task.locale)
    });
  }
  positionCompletionBanners();
}

async function handleCompletionNotifications(tasks, unreadThreadIDs = null) {
  const hasCompletionChange = !completionNotificationState.initialized
    || tasks.some((task) => (
      Number(task.completedAt) > Number(
        completionNotificationState.completions?.[task.id] || 0
      )
    ));
  const hasPendingNotifications = (
    Object.keys(completionNotificationState.pending || {}).length > 0
    || completionBannerEntries.size > 0
  );
  const hasDeferredNotifications = Object.keys(
    completionNotificationState.deferred || {}
  ).length > 0;
  if (!hasCompletionChange && !hasPendingNotifications && !hasDeferredNotifications) return;
  // Pending-banner cleanup only needs read receipts. Query the foreground
  // asynchronously only when a completion still needs a delivery decision.
  const frontmost = (hasCompletionChange || hasDeferredNotifications)
    ? isCodexFrontmost(
      await readFrontmostBundleIdentifier({ resourcesPath: process.resourcesPath }),
      discoveredCodexBundleIdentifiers()
    ) : null;
  if (quitting) return;
  const planned = planCompletionNotifications({
    tasks: tasks.map((task) => ({ ...task, locale: effectiveLocale() })),
    state: completionNotificationState,
    now: Date.now(),
    sessionStartedAt: APP_SESSION_STARTED_AT,
    enabled: settings.notifyOnUnreadCompletion,
    codexFrontmost: frontmost,
    unreadThreadIDs
  });
  persistCompletionNotificationState(planned.state);
  lastCompletionNotificationDecision = {
    checkedAt: Date.now(),
    foreground: frontmost === null ? "unknown" : frontmost ? "codex" : "other",
    unreadAvailable: unreadThreadIDs instanceof Set || Array.isArray(unreadThreadIDs),
    requestedCount: planned.notifications.length
  };
  for (const content of planned.notifications) {
    showCompletionNotification(content);
  }
  syncCompletionBanners(tasks, planned.state);
}

function taskRank(state) {
  if (state === "unread") return 0;
  if (state === "running") return 1;
  return 2;
}

function retainTasks(tasks) {
  const sorted = tasks.slice().sort((a, b) => {
    const rankDifference = taskRank(a.state) - taskRank(b.state);
    if (rankDifference !== 0) return rankDifference;
    if (a.activityAt !== b.activityAt) return b.activityAt - a.activityAt;
    return a.id.localeCompare(b.id);
  });
  const priority = sorted.filter(
    (task) => task.state === "unread" || task.state === "running"
  );
  if (priority.length >= 10) return priority;
  const completed = sorted.filter((task) => task.state === "completed");
  return priority.concat(completed.slice(0, 10 - priority.length));
}

function taskDataWorkerResourcesPath() {
  const packagedWorker = path.join(
    process.resourcesPath,
    "Worker",
    "task-data-worker.js"
  );
  return fs.existsSync(packagedWorker) ? process.resourcesPath : null;
}

function quotaDataWorkerResourcesPath() {
  const packagedWorker = path.join(
    process.resourcesPath,
    "Worker",
    "quota-data-worker.js"
  );
  return fs.existsSync(packagedWorker) ? process.resourcesPath : null;
}

function ensureQuotaDataClient() {
  if (!quotaDataClient) {
    quotaDataClient = new QuotaDataClient({
      executablePath: resolveCodexExecutable(),
      appVersion: APP_VERSION,
      resourcesPath: quotaDataWorkerResourcesPath(),
      onQuotaUpdate: (result) => {
        if (quitting || !result?.rateLimits) return;
        lastQuotaPrimaryError = null;
        applyQuotaRateLimits(result.rateLimits, {
          source: result.source,
          sampledAt: result.fetchedAt,
          persist: true
        });
      },
      onRefreshRequested: (reason) => {
        if (!quitting) scheduleQuotaRefresh(250, reason);
      },
      onProviderState: (state) => {
        persistResourceDiagnostics({ force: true });
        if (
          quitting
          || !["disconnected", "worker-exited"].includes(state?.state)
        ) {
          return;
        }
        const retryAt = Number(state.retryAt);
        const delay = Number.isFinite(retryAt)
          ? Math.max(1_000, retryAt - Date.now() + 500)
          : 30_000;
        scheduleQuotaRefresh(delay, "app-server-reconnect");
      }
    });
  }
  return quotaDataClient;
}

function ensureTaskDataClient() {
  if (!taskDataClient) {
    const { codexHome, globalStatePath } = activeCodexPaths();
    taskDataClient = new TaskDataClient({
      codexHome,
      globalStatePath,
      resourcesPath: taskDataWorkerResourcesPath()
    });
  }
  return taskDataClient;
}

function syncTranscriptWatchers(filePaths) {
  const next = new Set(filePaths.filter(Boolean));
  for (const [filePath, watcher] of transcriptWatchers) {
    if (next.has(filePath)) continue;
    try {
      watcher.close();
    } catch {
    }
    transcriptWatchers.delete(filePath);
  }
  for (const filePath of next) {
    if (transcriptWatchers.has(filePath)) continue;
    try {
      const watcher = fs.watch(
        filePath,
        { persistent: false },
        () => scheduleTaskRefresh(TASK_CHANGE_DEBOUNCE_MS, "transcript")
      );
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
        }
        if (transcriptWatchers.get(filePath) === watcher) {
          transcriptWatchers.delete(filePath);
        }
      });
      transcriptWatchers.set(filePath, watcher);
    } catch {
    }
  }
}

function startTaskSourceWatcher() {
  if (taskSourceWatcher) return;
  const { codexHome, globalStatePath } = activeCodexPaths();
  try {
    taskSourceWatcher = fs.watch(
      codexHome,
      { persistent: false },
      (_eventType, filename) => {
        const name = String(filename || "");
        if (
          name === path.basename(globalStatePath)
          || /^state_\d+\.sqlite(?:-wal|-shm)?$/i.test(name)
        ) {
          scheduleTaskRefresh(TASK_CHANGE_DEBOUNCE_MS, "codex-state");
        }
        if (name === "auth.json") {
          scheduleQuotaRefresh(TASK_CHANGE_DEBOUNCE_MS, "codex-auth");
          scheduleTaskRefresh(TASK_CHANGE_DEBOUNCE_MS, "codex-auth");
        }
      }
    );
    taskSourceWatcher.on("error", () => {
      try {
        taskSourceWatcher?.close();
      } catch {
      }
      taskSourceWatcher = null;
    });
  } catch {
    taskSourceWatcher = null;
  }
}

function stopTaskSourceWatchers() {
  try {
    taskSourceWatcher?.close();
  } catch {
  }
  taskSourceWatcher = null;
  for (const watcher of transcriptWatchers.values()) {
    try {
      watcher.close();
    } catch {
    }
  }
  transcriptWatchers.clear();
}

function resourceDiagnostics() {
  const memory = process.memoryUsage();
  return {
    version: 1,
    updatedAt: Date.now(),
    taskRefresh: {
      durationMs: lastTaskRefreshDurationMs,
      queryMode: lastTaskQueryMode,
      changedRowCount: lastTaskChangedRowCount,
      transcriptCacheSize: lastTranscriptCacheSize,
      fallbackIntervalMs: TASK_FALLBACK_REFRESH_MS,
      watchedTranscripts: transcriptWatchers.size,
      taskCount: snapshot.tasks.length,
      unreadCount: snapshot.unreadCount,
      runningCount: snapshot.runningCount
    },
    quotaRefresh: {
      intervalMs: QUOTA_REFRESH_MS,
      available: Boolean(snapshot.quota.available),
      remainingPercent: snapshot.quota.remainingPercent,
      timeRemainingPercent: snapshot.quota.timeRemainingPercent,
      resetAt: snapshot.quota.resetAt,
      source: lastQuotaSource,
      lastSuccessfulSyncAt: lastQuotaSyncAt,
      lastError: lastQuotaError,
      primaryError: lastQuotaPrimaryError,
      appServer: quotaDataClient?.diagnostics() || {
        workerRunning: false,
        workerStartCount: 0,
        state: "not-started",
        lastUpdateAt: null
      }
    },
    codexIpc: runtimeStatusClient?.diagnostics() || null,
    completionNotifications: {
      enabled: settings.notifyOnUnreadCompletion,
      pendingCount: Object.keys(completionNotificationState.pending || {}).length,
      deferredCount: Object.keys(completionNotificationState.deferred || {}).length,
      visible: Boolean(completionBannerWindow && !completionBannerWindow.isDestroyed()
        && completionBannerWindow.isVisible()),
      lastDecision: lastCompletionNotificationDecision
    },
    taskPanel: panelDiagnostics(),
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external
    }
  };
}

function persistResourceDiagnostics({ force = false } = {}) {
  const now = Date.now();
  if (
    !force
    && lastResourceDiagnosticsWriteAt > 0
    && now - lastResourceDiagnosticsWriteAt < RESOURCE_DIAGNOSTICS_MS
  ) {
    return;
  }
  checkPreparedPanelMemoryBudget();
  const diagnostics = resourceDiagnostics();
  const stable = JSON.stringify({
    ...diagnostics,
    updatedAt: 0
  });
  if (stable === lastResourceDiagnosticsJSON) return;
  lastResourceDiagnosticsJSON = stable;
  lastResourceDiagnosticsWriteAt = now;
  writeJSON(RESOURCE_DIAGNOSTICS_PATH, diagnostics);
}

async function refreshTasks() {
  if (refreshingTasks) {
    taskRefreshQueued = true;
    return;
  }
  refreshingTasks = true;
  try {
    const result = await ensureTaskDataClient().refresh();
    lastSuccessfulSyncAt = Date.now();
    lastTaskRefreshDurationMs = result.durationMs;
    lastTaskQueryMode = result.queryMode;
    lastTaskChangedRowCount = result.changedRowCount;
    lastTranscriptCacheSize = result.transcriptCacheSize;
    if (result.rateLimits && !snapshot.quota.available) {
      applyQuotaRateLimits(result.rateLimits, {
        source: "legacy-local-cache",
        sampledAt: result.rateLimitsAt || Date.now(),
        persist: false
      });
    }
    const unreadState = result.unread || { ids: [], available: false };
    const unread = new Set(unreadState.ids || []);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const tasks = [];
    const runtimeCandidates = [];
    const transcriptPaths = [];
    const now = Date.now();
    for (const row of rows) {
      if (!row?.id || !isTopLevelThread(row)) continue;
      const observation = row.observation || {
        latestProgress: "",
        latestProgressAt: 0,
        latestStartedAt: 0,
        latestCompletedAt: 0,
        isRunning: false
      };
      const activityAt = Math.max(
        observation.latestProgressAt,
        Number(row.recency_at_ms || 0),
        Number(row.updated_at_ms || 0)
      );
      const hasTranscript = Boolean(row.rollout_path);
      const transcriptRunning = Boolean(observation.isRunning)
        && activityAt >= now - TRANSCRIPT_RUNNING_MAX_AGE_MS;
      // Local transcripts are the primary, low-cost source. If a read-only
      // Codex IPC status is already available, however, keep it: an explicit
      // terminal state (for example `idle`) must be allowed to overrule an
      // older transcript that still appears open. We do not widen IPC probing
      // here, so normal transcript-backed tasks retain the low-cost path.
      const runtimeStatus = runtimeStatusClient?.statusFor(row.id) || "unknown";
      if (
        !hasTranscript
        && (
          isActiveRuntimeStatus(runtimeStatus)
          || activityAt >= now - ACTIVE_DISCOVERY_WINDOW_MS
        )
      ) {
        runtimeCandidates.push({
          id: row.id,
          priority: isActiveRuntimeStatus(runtimeStatus) ? 0 : 1,
          activityAt
        });
      }
      const state = classifyTask({
        isUnread: unread.has(row.id),
        hasOpenTurn: transcriptRunning,
        runtimeStatus
      });
      if (
        row.rollout_path
        && (state === "running" || transcriptRunning)
      ) {
        transcriptPaths.push(row.rollout_path);
      }
      const title = cleanDisplayText(
        row.name
          || row.display_title
          || row.preview
          || "Codex 会话",
        row.cwd || ""
      ) || "Codex 会话";
      const progress = cleanDisplayText(
        observation.latestProgress
          || (state === "running" ? "任务已开始，等待最新进展" : "任务已完成"),
        row.cwd || ""
      );
      tasks.push({
        id: row.id,
        title,
        progress,
        state,
        completedAt: observation.latestCompletedAt,
        activityAt
      });
    }
    syncTranscriptWatchers(transcriptPaths);
    // An unread-set read failure must not mark persistent banners as viewed.
    await handleCompletionNotifications(
      tasks,
      unreadState.available ? unread : null
    );
    const retained = retainTasks(tasks);
    const nextTaskState = {
      tasks: retained,
      unreadCount: tasks.filter((task) => task.state === "unread").length,
      runningCount: tasks.filter((task) => task.state === "running").length
    };
    const serialized = JSON.stringify(nextTaskState);
    if (serialized !== lastTaskSnapshotJSON) {
      lastTaskSnapshotJSON = serialized;
      snapshot.tasks = retained;
      snapshot.unreadCount = nextTaskState.unreadCount;
      snapshot.runningCount = nextTaskState.runningCount;
      broadcastSnapshot();
      refreshTrayMenu();
    }
    sendSettingsSnapshot();
    const candidateIds = runtimeCandidates
      .sort((a, b) => a.priority - b.priority || b.activityAt - a.activityAt)
      .map((candidate) => candidate.id);
    void runtimeStatusClient?.refreshCandidates(candidateIds);
    persistResourceDiagnostics();
  } catch {
    // Keep the last known snapshot. The low-frequency fallback will retry,
    // while Codex IPC and file watchers can schedule an earlier refresh.
  } finally {
    refreshingTasks = false;
    if (taskRefreshQueued) {
      taskRefreshQueued = false;
      scheduleTaskRefresh(TASK_CHANGE_DEBOUNCE_MS, "queued");
    }
  }
}

function scheduleTaskRefresh(
  delay = TASK_CHANGE_DEBOUNCE_MS,
  _reason = "change"
) {
  if (taskRefreshTimer) {
    if (delay > 0) return;
    clearTimeout(taskRefreshTimer);
  }
  taskRefreshTimer = setTimeout(() => {
    taskRefreshTimer = null;
    void refreshTasks();
  }, Math.max(0, delay));
  taskRefreshTimer.unref?.();
}

function dateFromEpoch(value) {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number > 1e12 ? number : number * 1_000);
}

function firstFinite(source, keys) {
  for (const key of keys) {
    const number = Number(source?.[key]);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return null;
}

function parseQuota(result) {
  const limits = result?.rateLimits
    || result?.rate_limits
    || result?.limits
    || result;
  if (!limits) return snapshot.quota;
  const windows = [
    limits.primary,
    limits.secondary,
    ...(Array.isArray(limits.windows) ? limits.windows : [])
  ].filter((window) => window && typeof window === "object");
  const durationFor = (window) => {
    const minutes = firstFinite(window, [
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes"
    ]);
    if (minutes !== null) return minutes;
    const seconds = firstFinite(window, [
      "limitWindowSeconds",
      "limit_window_seconds",
      "windowSeconds",
      "window_seconds"
    ]);
    return seconds === null ? null : seconds / 60;
  };
  const weekly = windows
    .filter((window) => Number(durationFor(window)) > 720)
    .sort(
      (a, b) => Number(durationFor(b)) - Number(durationFor(a))
    )[0];
  if (!weekly) {
    return snapshot.quota;
  }
  const suppliedUsed = firstFinite(weekly, ["usedPercent", "used_percent"]);
  const suppliedRemaining = firstFinite(weekly, [
    "remainingPercent",
    "remaining_percent"
  ]);
  const rawUsed = suppliedUsed ?? (
    suppliedRemaining === null ? null : 100 - suppliedRemaining
  );
  if (!Number.isFinite(rawUsed)) return snapshot.quota;
  const usedPercent = Math.max(0, Math.min(100, rawUsed));
  const remainingPercent = 100 - usedPercent;
  const resetAt = dateFromEpoch(firstValue(weekly, [
    "resetsAt",
    "resets_at",
    "resetAt",
    "reset_at"
  ]));
  const durationMinutes = durationFor(weekly);
  const remainingMinutes = resetAt
    ? Math.max(0, (resetAt.getTime() - Date.now()) / 60_000)
    : null;
  const timeRemainingPercent = Number.isFinite(remainingMinutes)
    ? Math.max(0, Math.min(100, remainingMinutes / durationMinutes * 100))
    : null;
  return withQuotaHealth({
    available: true,
    usedPercent,
    remainingPercent,
    timeRemainingPercent,
    windowMinutes: durationMinutes,
    resetAt: resetAt?.getTime() || null
  });
}

function withQuotaHealth(quota) {
  const health = evaluateQuotaHealth({
    usedPercent: quota.usedPercent,
    remainingPercent: quota.remainingPercent,
    timeRemainingPercent: quota.timeRemainingPercent,
    windowMinutes: quota.windowMinutes,
    healthyLeadDays: settings.quotaHealthyLeadDays,
    warningLeadDays: settings.quotaWarningLeadDays,
    mode: settings.quotaHealthMode
  });
  return {
    ...quota,
    health: health.health,
    healthLabel: health.label,
    healthDescription: health.description,
    cycleDays: health.cycleDays,
    elapsedDays: health.elapsedDays,
    currentDayEnd: health.currentDayEnd,
    usedEquivalentDays: health.usedEquivalentDays,
    leadDays: health.leadDays,
    healthProgress: health.healthProgress
  };
}

function refreshSnapshotQuotaHealth() {
  if (!snapshot.quota.available) return;
  snapshot.quota = withQuotaHealth(snapshot.quota);
}

function resolveCodexExecutable() {
  if (codexExecutablePath) {
    try {
      fs.accessSync(codexExecutablePath, fs.constants.X_OK);
      return codexExecutablePath;
    } catch {
      codexExecutablePath = null;
    }
  }
  codexExecutablePath = discoverCodexExecutable();
  return codexExecutablePath;
}

function formatCountdown(resetAt) {
  const english = effectiveLocale() === "en";
  if (!Number.isFinite(resetAt)) return copyFor().syncing;
  const totalMinutes = Math.max(0, Math.round((resetAt - Date.now()) / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(english ? `${days}d` : `${days}天`);
  if (hours > 0) parts.push(english ? `${hours}h` : `${hours}小时`);
  if (days === 0 && minutes > 0) parts.push(english ? `${minutes}m` : `${minutes}分钟`);
  return parts.join(" ") || (english ? "under 1 min" : "不足 1 分钟");
}

function dotSnapshot() {
  const quota = snapshot.quota;
  const copy = copyFor();
  return {
    health: quota.health,
    healthProgress: quota.healthProgress,
    quotaAvailable: quota.available,
    quotaRemainingPercent: quota.remainingPercent || 0,
    timeRemainingPercent: quota.timeRemainingPercent || 0,
    unreadCount: snapshot.unreadCount,
    runningCount: snapshot.runningCount,
    locale: effectiveLocale(),
    accessibilityLabel: effectiveLocale() === "en"
      ? `${snapshot.unreadCount} unread completed tasks, ${snapshot.runningCount} running tasks`
      : `${snapshot.unreadCount} 个已完成任务待查看，${snapshot.runningCount} 个任务进行中`,
    appName: copy.appName
  };
}

function panelSnapshot() {
  const quota = snapshot.quota;
  const copy = copyFor();
  const health = copy.health[quota.health] || copy.health.neutral;
  return {
    direction: panelDirection,
    arrowX: panelArrowX,
    locale: effectiveLocale(),
    health: quota.health,
    healthLabel: health[0],
    healthDescription: health[1],
    quotaValue: quota.available ? `${Math.round(quota.remainingPercent)}%` : "–",
    timeValue: quota.available && Number.isFinite(quota.timeRemainingPercent)
      ? `${Math.round(quota.timeRemainingPercent)}%`
      : "–",
    resetValue: quota.available ? formatCountdown(quota.resetAt) : "待同步",
    unreadCount: snapshot.unreadCount,
    runningCount: snapshot.runningCount,
    copy: {
      quotaRemaining: copy.quotaRemaining,
      timeRemaining: copy.timeRemaining,
      resetCountdown: copy.resetCountdown,
      taskProgress: copy.taskProgress,
      unread: copy.unread,
      running: copy.running,
      completed: copy.completed,
      syncing: copy.syncing
    },
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      progress: task.progress,
      stateLabel: task.state === "unread"
        ? copy.unread
        : task.state === "running" ? copy.running : copy.completed,
      stateClass: task.state
    }))
  };
}

function sendDotSnapshot() {
  if (dotWindow && !dotWindow.isDestroyed()) {
    dotWindow.webContents.send("companion:snapshot", dotSnapshot());
  }
}

function sendPanelSnapshot() {
  if (!panelRendererReady || !panelWindow || panelWindow.isDestroyed()) return;
  const state = panelSnapshot();
  const { direction, arrowX, ...content } = state;
  const json = JSON.stringify(content);
  // Data changes, not clicks or pointer moves, drive preparation. Hidden
  // updates are incremental and happen only when displayed values change.
  if (json !== panelSnapshotJSON) {
    panelSnapshotJSON = json;
    panelRenderRevision += 1;
    panelWindow.webContents.send("companion:snapshot", {
      ...state,
      renderRevision: panelRenderRevision
    });
  }
  schedulePanelClockUpdate();
}

function schedulePanelClockUpdate() {
  clearPanelClockTimer();
  const remaining = snapshot.quota?.available
    ? snapshot.quota.resetAt - Date.now()
    : 0;
  if (!panelWindow || panelWindow.isDestroyed() || !Number.isFinite(remaining)
      || remaining <= 30_000) return;
  // formatCountdown rounds minutes. Update at its next actual text boundary,
  // at most once a minute, without polling Codex or running hidden frames.
  const delay = ((remaining - 30_000) % 60_000 + 60_000) % 60_000 + 20;
  panelClockTimer = setTimeout(() => {
    panelClockTimer = null;
    sendPanelSnapshot();
  }, delay);
  panelClockTimer.unref();
}

function sendPanelPosition() {
  if (panelAnchor && panelWindow && !panelWindow.isDestroyed()) {
    // Dragging changes geometry only. Keep the existing renderer tree alive;
    // rebuilding the task cards for every mouse move causes visible flashes.
    panelWindow.webContents.send("companion:position", {
      direction: panelDirection,
      arrowX: panelArrowX
    });
  }
}

function broadcastSnapshot() {
  sendDotSnapshot();
  sendPanelSnapshot();
}

function openCodex() {
  const executable = resolveCodexExecutable();
  const bundlePath = appBundleForExecutable(executable);
  const candidates = [
    ...(bundlePath ? [["-a", bundlePath]] : []),
    ["-b", "com.openai.codex"],
    ["-b", "com.openai.chat"]
  ];
  const attempt = (index) => {
    if (index >= candidates.length) return;
    childProcess.execFile(
      "/usr/bin/open",
      candidates[index],
      { timeout: 5_000 },
      (error) => {
        if (error) attempt(index + 1);
      }
    );
  };
  attempt(0);
}

app.on("second-instance", (_event, commandLine) => {
  if (!hasSingleInstanceLock) return;
  ensureMenuBarTray("second-instance");
  if (!handleMenuCommand(menuCommandFromArguments(commandLine))) {
    showSettings();
  }
});

function settingsRequest(handler) {
  return (event, ...args) => {
    if (!trustedRendererEvent(event, settingsWindow, rendererURL(__dirname, "settings.html"))) {
      throw new Error("Untrusted settings request");
    }
    return handler(...args);
  };
}

ipcMain.handle("companion:settings-get", settingsRequest(() => settingsSnapshot()));
ipcMain.handle("companion:settings-update", settingsRequest((patch) => updateSettings(patch)));
ipcMain.handle("companion:settings-choose-codex-folder", settingsRequest(() => chooseCodexDataFolder()));
ipcMain.handle("companion:settings-restore-default-codex", settingsRequest(() => (
  redetectCodexConnection()
)));
ipcMain.handle("companion:settings-retry-codex", settingsRequest(() => (
  redetectCodexConnection()
)));
ipcMain.handle("companion:settings-open-codex", settingsRequest(() => {
  openCodex();
  return { opened: true };
}));
ipcMain.handle("companion:settings-open-menu-bar-settings", settingsRequest(() => (
  openMenuBarSystemSettings()
)));

ipcMain.on("companion:dot-message", (event, message) => {
  if (!trustedRendererEvent(event, dotWindow, rendererURL(__dirname, "dot.html"))) return;
  switch (message?.type) {
  case "ready":
    sendDotSnapshot();
    break;
  case "enter":
    handleEnter();
    break;
  case "leave":
    handleLeave();
    break;
  case "click":
    openCodex();
    break;
  case "dragStart":
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    break;
  case "move":
    if (!dotWindow || dotWindow.isDestroyed()) break;
    {
      const [x, y] = dotWindow.getPosition();
      dotWindow.setPosition(
        Math.round(x + Number(message.dx || 0)),
        Math.round(y + Number(message.dy || 0))
      );
    }
    break;
  case "dragEnd":
    if (!dotWindow || dotWindow.isDestroyed()) break;
    reconcileDesktopWidgetPosition();
    break;
  default:
    break;
  }
});

ipcMain.on("companion:panel-message", (event, message) => {
  if (!trustedRendererEvent(event, panelWindow, rendererURL(__dirname, "panel.html"))) return;
  switch (message?.type) {
  case "ready":
    panelRendererReady = true;
    sendPanelSnapshot();
    break;
  case "enter":
    if (panelAnchor && panelWindow.isVisible()) handleEnter();
    break;
  case "leave":
    if (panelAnchor && panelWindow.isVisible()) handleLeave();
    break;
  case "resize":
    resizePanel(message.height, message.renderRevision);
    break;
  case "rendered":
    resizePanel(panelReportedHeight, message.renderRevision);
    break;
  case "presented":
    showPreparedPanel(message);
    break;
  case "frame":
    if (
      panelAnchor && panelWindow.isVisible()
      && message.presentationID === panelPresentationID
      && message.renderRevision === panelRenderRevision
      && Number.isFinite(message.latencyMs) && message.latencyMs >= 0
    ) {
      panelLastFrameLatencyMs = message.latencyMs;
      writeMenuBarRuntime();
    }
    break;
  case "openTask":
    if (panelAnchor && panelWindow.isVisible()
        && typeof message.id === "string" && message.id) {
      closePanel();
      openTask(message.id);
    }
    break;
  default:
    break;
  }
});

ipcMain.on("companion:notification-message", (event, message) => {
  if (!trustedRendererEvent(event, completionBannerWindow, rendererURL(__dirname, "notification.html"))) return;
  if (message?.type === "ready") {
    sendCompletionBannerContent();
    return;
  }
  if (message?.type === "open") {
    const threadID = message?.threadID;
    if (threadID) openTask(threadID);
    return;
  }
  if (message?.type === "close" && message?.threadID) {
    dismissCompletionBanner(message.threadID);
    return;
  }
  if (message?.type === "toggle-expanded") {
    if (completionBannerEntries.size <= 1) return;
    completionBannerExpanded = !completionBannerExpanded;
    positionCompletionBanners();
    sendCompletionBannerContent();
  }
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  // The signed bundle declares LSUIElement=true before AppKit starts, so this
  // process is a menu-bar accessory from its first frame and never registers a
  // transient Dock icon. Do not switch activation policy at runtime: macOS 26
  // can tear down and re-register status-item scenes when an app changes
  // between regular and accessory modes after startup.
  Menu.setApplicationMenu(null);
  screen.on("display-added", handleDisplayLayoutChange);
  screen.on("display-removed", handleDisplayLayoutChange);
  screen.on("display-metrics-changed", handleDisplayLayoutChange);
  ensureMenuBarTray("app-ready");
  startMenuBarLifecycleMonitoring();
  if (process.argv.includes("--self-test-menu-bar-recovery")) {
    setTimeout(() => {
      if (menuBarTray && !menuBarTray.isDestroyed()) menuBarTray.destroy();
      ensureMenuBarTray("self-test-recovery");
    }, 500).unref();
  }
  migrateLegacyLaunchAgent({
    home: HOME,
    uid: process.getuid?.(),
    fsModule: fs,
    execFileSync: childProcess.execFileSync
  });
  syncMacLoginItem();
  syncBackgroundRecovery();
  activateSelectedFolderAccess();
  restoreCachedQuota();
  startTaskSourceWatcher();
  ensureDesktopWidget();
  // A new install opens the full Settings page with the recommended defaults.
  // The legacy flag is now only a one-time launch marker; there is no separate
  // onboarding flow or confirmation step.
  const shouldPresentInitialSettings = !settings.onboardingCompleted;
  if (shouldPresentInitialSettings) {
    persistSettings({ ...settings, onboardingCompleted: true });
  }
  if (shouldPresentInitialSettings || process.argv.includes("--show-settings")) {
    setTimeout(showSettings, 180);
  }
  if (process.argv.includes("--show-notification-preview")) {
    setTimeout(() => showCompletionNotification({
      threadID: "preview",
      title: "拆解 AI 学习研究提示词架构",
      body: "适配器字段与验证脚本已补齐，正在等待你查看最终结果。",
      preview: true
    }), 260);
  }
  if (process.argv.includes("--show-notification-preview-group")) {
    setTimeout(() => {
      const completedAt = Date.now();
      const previews = [
        ["preview-group-1", "完善预算健康度说明", "已完成设置文案与边界校验，等待你查看最终结果。"],
        ["preview-group-2", "修复菜单栏图标可见性", "已完成多显示器回归检查，并同步最新状态。"],
        ["preview-group-3", "更新完成提醒交互", "已完成原生通知组栈实现，等待你查看设计验收。"],
        ["preview-group-4", "整理 Codex 任务状态", "已完成未读状态校验，等待你确认任务进展。"]
      ];
      previews.forEach(([threadID, title, body], index) => {
        showCompletionNotification({
          threadID,
          title,
          body,
          completedAt: completedAt - index,
          preview: true
        });
      });
    }, 260);
  }
  void refreshTasks();
  void refreshQuota("startup");
  // Defer the one-time lightweight view setup until the normal startup work
  // has been scheduled. A crash or memory-budget release is not auto-prewarmed
  // again: only the next user open may recreate it.
  setImmediate(() => {
    if (quitting || (panelWindow && !panelWindow.isDestroyed())) return;
    panelPrewarmCount += 1;
    preparePanel();
  });
  setInterval(
    () => scheduleTaskRefresh(0, "fallback"),
    TASK_FALLBACK_REFRESH_MS
  ).unref();
  setInterval(
    () => scheduleQuotaRefresh(0, "fallback"),
    QUOTA_REFRESH_MS
  ).unref();
  setInterval(
    () => recoverAutomaticCodexConnection(),
    CODEX_DISCOVERY_REFRESH_MS
  ).unref();
  setInterval(
    () => persistResourceDiagnostics({ force: true }),
    RESOURCE_DIAGNOSTICS_MS
  ).unref();
});

app.on("activate", () => {
  if (!hasSingleInstanceLock) return;
  ensureMenuBarTray("app-activate");
  showSettings();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  quitting = true;
  if (backgroundRecoveryStableTimer) {
    clearTimeout(backgroundRecoveryStableTimer);
    backgroundRecoveryStableTimer = null;
  }
  backgroundRecovery?.stop({ graceful: true });
  stopTaskSourceWatchers();
  taskDataClient?.stop();
  taskDataClient = null;
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  destroyPanel();
  clearMenuBarRetryTimer();
  clearMenuBarPlacementTimer();
  if (menuBarHealthTimer) {
    clearInterval(menuBarHealthTimer);
    menuBarHealthTimer = null;
  }
  if (taskRefreshTimer) {
    clearTimeout(taskRefreshTimer);
    taskRefreshTimer = null;
  }
  if (quotaRefreshDebounceTimer) {
    clearTimeout(quotaRefreshDebounceTimer);
    quotaRefreshDebounceTimer = null;
  }
  closeAllCompletionBanners();
  runtimeStatusClient?.stop();
  quotaDataClient?.stop();
  quotaDataClient = null;
  try {
    stopSecurityScopedAccess?.();
  } catch {
  }
  stopSecurityScopedAccess = null;
  menuBarTray?.destroy();
  menuBarTray = null;
  menuBarTrayImage = null;
  try {
    fs.rmSync(TRAY_RUNTIME_PATH, { force: true });
  } catch {
  }
});
