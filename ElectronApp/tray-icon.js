"use strict";

const fs = require("fs");
const path = require("path");

function trayIconPaths(resourcesPath, mode = "full") {
  if (mode !== "full" && mode !== "quota-star") {
    throw new Error(`Unknown menu-bar icon mode: ${mode}`);
  }
  const directory = path.join(resourcesPath, "TrayIcon");
  const name = mode === "quota-star" ? "CodexQuotaStarTemplate" : "CodexCompanionTemplate";
  return {
    oneX: path.join(directory, `${name}.png`),
    twoX: path.join(directory, `${name}@2x.png`)
  };
}

function createTrayIcon(resourcesPath, mode = "full") {
  const paths = trayIconPaths(resourcesPath, mode);
  if (!fs.existsSync(paths.oneX) || fs.statSync(paths.oneX).size === 0) {
    throw new Error(`Menu-bar template image is missing: ${paths.oneX}`);
  }
  if (!fs.existsSync(paths.twoX) || fs.statSync(paths.twoX).size === 0) {
    throw new Error(`Retina menu-bar template image is missing: ${paths.twoX}`);
  }
  // Pass the base Template filename to Electron. On macOS this is what makes
  // the image loader associate CodexCompanionTemplate@2x.png as the Retina
  // representation and lets the system tint both variants consistently.
  return paths.oneX;
}

function formatCompactCountdown(resetAt, now = Date.now()) {
  if (!Number.isFinite(resetAt)) return null;
  const remainingHours = Math.max(0, Math.ceil((resetAt - now) / 3_600_000));
  const days = Math.floor(remainingHours / 24);
  const hours = remainingHours % 24;
  return `${days}d${String(hours).padStart(2, "0")}h`;
}

function formatTrayQuotaTitle({
  showMenuBarQuota,
  quotaAvailable,
  remainingPercent,
  resetAt,
  now = Date.now()
}) {
  if (!showMenuBarQuota) return "";
  if (
    !quotaAvailable
    || !Number.isFinite(remainingPercent)
    || (Number.isFinite(resetAt) && resetAt <= now)
  ) {
    return "—";
  }
  return `${Math.round(Math.max(0, Math.min(100, remainingPercent)))}%`;
}

function syncTrayQuotaTitle(tray, options) {
  const title = formatTrayQuotaTitle(options);
  // Update the existing native status item rather than creating another one.
  // Avoid a layout update when task activity changes but weekly quota does not.
  if (tray.getTitle() !== title) {
    tray.setTitle(title, { fontType: "monospacedDigit" });
  }
  return title;
}

function formatTrayQuotaLine({
  locale,
  quotaAvailable,
  remainingPercent,
  resetAt,
  now = Date.now()
}) {
  const quota = quotaAvailable && Number.isFinite(remainingPercent)
    ? `${Math.round(remainingPercent)}%`
    : locale === "en" ? "Syncing" : "待同步";
  const countdown = quotaAvailable
    ? formatCompactCountdown(resetAt, now)
    : null;
  const reset = countdown || (locale === "en" ? "Syncing" : "待同步");
  return locale === "en"
    ? `Quota: ${quota}; Reset: ${reset}`
    : `额度：${quota}；倒计时：${reset}`;
}

function formatTrayTaskLine({ locale, unreadCount, runningCount }) {
  const unread = Math.max(0, Number(unreadCount) || 0);
  const running = Math.max(0, Number(runningCount) || 0);
  return locale === "en"
    ? `Unread: ${unread}; Running: ${running};`
    : `「${unread}」待查看；「${running}」进行中；`;
}

module.exports = {
  createTrayIcon,
  formatCompactCountdown,
  formatTrayQuotaTitle,
  formatTrayQuotaLine,
  formatTrayTaskLine,
  syncTrayQuotaTitle,
  trayIconPaths
};
