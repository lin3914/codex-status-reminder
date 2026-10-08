"use strict";

const {
  DEFAULT_QUOTA_HEALTH_MODE,
  DEFAULT_HEALTHY_LEAD_DAYS,
  DEFAULT_WARNING_LEAD_DAYS,
  deriveWarningLeadDays,
  normalizeQuotaHealthMode,
  normalizeQuotaHealthThresholds
} = require("./quota-health");
const { normalizeCodexConnection } = require("./codex-connection");

const SETTINGS_SCHEMA_VERSION = 5;
const QUOTA_HEALTH_SCHEMA_VERSION = 3;

const DEFAULT_SETTINGS = Object.freeze({
  locale: "system",
  showDesktopWidget: true,
  showMenuBarQuota: true,
  notifyOnUnreadCompletion: true,
  quotaHealthMode: DEFAULT_QUOTA_HEALTH_MODE,
  quotaHealthyLeadDays: DEFAULT_HEALTHY_LEAD_DAYS,
  quotaWarningLeadDays: DEFAULT_WARNING_LEAD_DAYS,
  launchAtLogin: true,
  onboardingCompleted: false,
  codexConnection: normalizeCodexConnection()
});

const LEGACY_SETTING_KEYS = Object.freeze([
  "locale",
  "showDesktopWidget",
  "showHoverPanel",
  "notifyOnUnreadCompletion",
  "alwaysOnTop",
  "showOnAllWorkspaces",
  "quotaHealthMode",
  "quotaHealthyLeadDays",
  "quotaWarningLeadDays",
  "launchAtBoot",
  "launchAtLogin",
  "keepInBackground",
  "recoverAfterCrash",
  "codexConnection",
  "x",
  "y"
]);

function booleanOrDefault(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeLocale(value) {
  return value === "en" || value === "zh-CN" || value === "system"
    ? value
    : DEFAULT_SETTINGS.locale;
}

function hasLegacySettings(source) {
  return LEGACY_SETTING_KEYS.some((key) => Object.hasOwn(source, key));
}

function legacyStartupMigration(source) {
  const hasLegacyStartup = typeof source.launchAtBoot === "boolean"
    || typeof source.launchAtLogin === "boolean";
  return hasLegacyStartup
    ? Boolean(source.launchAtBoot || source.launchAtLogin)
    : DEFAULT_SETTINGS.launchAtLogin;
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const sourceSchemaVersion = Number(source.settingsSchemaVersion || 0);
  const migratingLegacySettings = sourceSchemaVersion < SETTINGS_SCHEMA_VERSION
    && hasLegacySettings(source);
  const isLegacyQuotaHealthDefault = Number(source.quotaHealthSchemaVersion || 0) < 2
    && source.quotaHealthyLeadDays === 0
    && source.quotaWarningLeadDays === 1;
  const hasExplicitQuotaHealthMode = source.quotaHealthMode === "linked"
    || source.quotaHealthMode === "custom";
  const healthyCandidate = isLegacyQuotaHealthDefault
    ? DEFAULT_HEALTHY_LEAD_DAYS
    : source.quotaHealthyLeadDays;
  const inferredQuotaHealthMode = hasExplicitQuotaHealthMode
    ? normalizeQuotaHealthMode(source.quotaHealthMode)
    : (
      source.quotaHealthyLeadDays === undefined
      && source.quotaWarningLeadDays === undefined
        ? DEFAULT_QUOTA_HEALTH_MODE
        :
      source.quotaHealthSchemaVersion === 2
      && source.quotaHealthyLeadDays === 0
      && source.quotaWarningLeadDays === 1
        ? "custom"
        : Math.abs(
          Number(source.quotaWarningLeadDays)
            - deriveWarningLeadDays(healthyCandidate)
        ) < 0.001
          ? DEFAULT_QUOTA_HEALTH_MODE
          : "custom"
    );
  const quotaHealthMode = isLegacyQuotaHealthDefault
    ? DEFAULT_QUOTA_HEALTH_MODE
    : inferredQuotaHealthMode;
  const healthThresholds = normalizeQuotaHealthThresholds({
    healthyLeadDays: healthyCandidate,
    warningLeadDays: source.quotaWarningLeadDays,
    mode: quotaHealthMode
  });
  const normalized = {
    ...DEFAULT_SETTINGS,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    locale: normalizeLocale(source.locale),
    showDesktopWidget: booleanOrDefault(
      source.showDesktopWidget,
      DEFAULT_SETTINGS.showDesktopWidget
    ),
    showMenuBarQuota: booleanOrDefault(
      source.showMenuBarQuota,
      DEFAULT_SETTINGS.showMenuBarQuota
    ),
    notifyOnUnreadCompletion: booleanOrDefault(
      source.notifyOnUnreadCompletion,
      DEFAULT_SETTINGS.notifyOnUnreadCompletion
    ),
    quotaHealthMode,
    quotaHealthyLeadDays: healthThresholds.healthyLeadDays,
    quotaWarningLeadDays: healthThresholds.warningLeadDays,
    codexDiscoveryFailures: Number.isFinite(Number(source.codexDiscoveryFailures))
      ? Math.max(0, Math.floor(Number(source.codexDiscoveryFailures)))
      : 0,
    quotaHealthSchemaVersion: QUOTA_HEALTH_SCHEMA_VERSION,
    launchAtLogin: migratingLegacySettings
      ? legacyStartupMigration(source)
      : booleanOrDefault(source.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    onboardingCompleted: migratingLegacySettings
      ? true
      : booleanOrDefault(
        source.onboardingCompleted,
        DEFAULT_SETTINGS.onboardingCompleted
      ),
    codexConnection: normalizeCodexConnection(source.codexConnection)
  };
  if (Number.isFinite(source.x)) normalized.x = Math.round(source.x);
  if (Number.isFinite(source.y)) normalized.y = Math.round(source.y);
  return normalized;
}

function editableSettings(value = {}) {
  const normalized = normalizeSettings(value);
  return {
    locale: normalized.locale,
    showDesktopWidget: normalized.showDesktopWidget,
    showMenuBarQuota: normalized.showMenuBarQuota,
    notifyOnUnreadCompletion: normalized.notifyOnUnreadCompletion,
    quotaHealthMode: normalized.quotaHealthMode,
    quotaHealthyLeadDays: normalized.quotaHealthyLeadDays,
    quotaWarningLeadDays: normalized.quotaWarningLeadDays,
    launchAtLogin: normalized.launchAtLogin,
    onboardingCompleted: normalized.onboardingCompleted,
    codexConnection: normalized.codexConnection
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  editableSettings,
  normalizeLocale,
  normalizeSettings
};
