"use strict";

const assert = require("assert");
const {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  editableSettings,
  normalizeSettings
} = require("../../ElectronApp/settings-store");

const defaults = normalizeSettings();
assert.deepStrictEqual(editableSettings(defaults), DEFAULT_SETTINGS);
assert.equal(defaults.settingsSchemaVersion, SETTINGS_SCHEMA_VERSION);
assert.equal(defaults.locale, "system");
assert.equal(defaults.showMenuBarQuota, true);
assert.equal(defaults.onboardingCompleted, false);
for (const fixedKey of [
  "showHoverPanel",
  "alwaysOnTop",
  "showOnAllWorkspaces",
  "recoverAfterCrash"
]) {
  assert.equal(
    Object.hasOwn(defaults, fixedKey),
    false,
    `${fixedKey} must be a software constraint rather than a saved preference`
  );
}

const legacyPosition = normalizeSettings({ x: 182.4, y: 350.6 });
assert.strictEqual(legacyPosition.x, 182);
assert.strictEqual(legacyPosition.y, 351);
assert.strictEqual(legacyPosition.locale, "system");
assert.strictEqual(legacyPosition.quotaHealthMode, "linked");
assert.strictEqual(legacyPosition.quotaHealthyLeadDays, 0.5);
assert.strictEqual(legacyPosition.quotaWarningLeadDays, 1);
assert.equal(legacyPosition.codexConnection.kind, "auto-discovered");
assert.equal(legacyPosition.codexConnection.readOnly, true);
assert.equal(
  legacyPosition.onboardingCompleted,
  true,
  "an existing installation must not be forced through onboarding"
);

const configured = normalizeSettings({
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  locale: "en",
  showDesktopWidget: false,
  showMenuBarQuota: false,
  showHoverPanel: false,
  notifyOnUnreadCompletion: false,
  alwaysOnTop: false,
  showOnAllWorkspaces: false,
  quotaHealthMode: "custom",
  quotaHealthyLeadDays: 0.5,
  quotaWarningLeadDays: 1.5,
  launchAtLogin: false,
  recoverAfterCrash: true,
  onboardingCompleted: true,
  codexConnection: {
    kind: "user-selected-folder",
    codexHome: "/Volumes/Codex Data",
    securityScopedBookmark: null,
    selectedAt: 42
  }
});
assert.deepStrictEqual(editableSettings(configured), {
  locale: "en",
  showDesktopWidget: false,
  showMenuBarQuota: false,
  notifyOnUnreadCompletion: false,
  quotaHealthMode: "custom",
  quotaHealthyLeadDays: 0.5,
  quotaWarningLeadDays: 1.5,
  launchAtLogin: false,
  onboardingCompleted: true,
  codexConnection: {
    schemaVersion: 2,
    kind: "user-selected-folder",
    codexHome: "/Volumes/Codex Data",
    readOnly: true,
    securityScopedBookmark: null,
    selectedAt: 42,
    discoverySource: null
  }
});
for (const fixedKey of [
  "showHoverPanel",
  "alwaysOnTop",
  "showOnAllWorkspaces",
  "recoverAfterCrash"
]) {
  assert.equal(
    Object.hasOwn(configured, fixedKey),
    false,
    `${fixedKey} must ignore a legacy persisted value`
  );
}

const migratedStartup = normalizeSettings({
  locale: "zh-CN",
  launchAtBoot: true,
  launchAtLogin: false,
  keepInBackground: true
});
assert.equal(migratedStartup.launchAtLogin, true);
assert.equal(migratedStartup.onboardingCompleted, true);
assert.equal(Object.hasOwn(migratedStartup, "launchAtBoot"), false);
assert.equal(Object.hasOwn(migratedStartup, "keepInBackground"), false);

assert.equal(
  normalizeSettings({ settingsSchemaVersion: 5, launchAtLogin: false }).showMenuBarQuota,
  true,
  "an existing installation must gain the quota display without changing unrelated preferences"
);
assert.equal(
  normalizeSettings({ settingsSchemaVersion: 5, launchAtLogin: false }).launchAtLogin,
  false
);
assert.equal(normalizeSettings({ showMenuBarQuota: "false" }).showMenuBarQuota, true);
assert.equal(
  normalizeSettings(JSON.parse(JSON.stringify(
    normalizeSettings({ showMenuBarQuota: false })
  ))).showMenuBarQuota,
  false,
  "an explicitly disabled quota title must survive saving and restarting"
);

const postMigrationStartup = normalizeSettings({
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  launchAtBoot: true,
  launchAtLogin: false,
  keepInBackground: true,
  recoverAfterCrash: false,
  onboardingCompleted: true
});
assert.equal(
  postMigrationStartup.launchAtLogin,
  false,
  "legacy values must not override a post-migration choice"
);
assert.equal(Object.hasOwn(postMigrationStartup, "recoverAfterCrash"), false);

assert.strictEqual(
  normalizeSettings({
    quotaHealthyLeadDays: 2.9,
    quotaWarningLeadDays: -1
  }).quotaWarningLeadDays,
  3,
  "额度健康阈值应规范化且保持有序"
);
assert.deepStrictEqual(
  [
    normalizeSettings({ quotaHealthyLeadDays: 0, quotaWarningLeadDays: 1 })
      .quotaHealthyLeadDays,
    normalizeSettings({ quotaHealthyLeadDays: 0, quotaWarningLeadDays: 1 })
      .quotaWarningLeadDays
  ],
  [0.5, 1],
  "旧版本默认的 0/1 天阈值应迁移为新的 0.5/1 天标准"
);
assert.equal(
  normalizeSettings({
    quotaHealthSchemaVersion: 2,
    quotaHealthyLeadDays: 0,
    quotaWarningLeadDays: 1
  }).quotaHealthyLeadDays,
  0,
  "迁移完成后用户仍可明确选择 0 天健康上限"
);
assert.equal(
  normalizeSettings({
    quotaHealthSchemaVersion: 2,
    quotaHealthyLeadDays: 0,
    quotaWarningLeadDays: 1
  }).quotaHealthMode,
  "custom",
  "旧版本中明确保留的 0/1 天自定义阈值不能被简化模式覆盖"
);
assert.deepStrictEqual(
  [
    normalizeSettings({
      quotaHealthSchemaVersion: 2,
      quotaHealthyLeadDays: 0.5,
      quotaWarningLeadDays: 1
    }).quotaHealthMode,
    normalizeSettings({
      quotaHealthSchemaVersion: 2,
      quotaHealthyLeadDays: 0.5,
      quotaWarningLeadDays: 1
    }).quotaWarningLeadDays
  ],
  ["linked", 1],
  "已有默认 0.5/1 天配置应自动切换到联动模式"
);
assert.deepStrictEqual(
  [
    normalizeSettings({
      quotaHealthMode: "linked",
      quotaHealthyLeadDays: 0.25,
      quotaWarningLeadDays: 3
    }).quotaHealthyLeadDays,
    normalizeSettings({
      quotaHealthMode: "linked",
      quotaHealthyLeadDays: 0.25,
      quotaWarningLeadDays: 3
    }).quotaWarningLeadDays
  ],
  [0.25, 0.5],
  "联动模式应忽略旧警示值并按健康上限自动翻倍"
);

console.log("PASS settings-store");
