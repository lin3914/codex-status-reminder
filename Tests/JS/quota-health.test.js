"use strict";

const assert = require("assert/strict");
const {
  DEFAULT_HEALTHY_LEAD_DAYS,
  DEFAULT_WARNING_LEAD_DAYS,
  QUOTA_HEALTH_MODE,
  deriveWarningLeadDays,
  evaluateQuotaHealth,
  normalizeQuotaHealthThresholds
} = require("../../ElectronApp/quota-health");

const assess = (
  usedPercent,
  timeRemainingPercent,
  thresholds = {}
) => evaluateQuotaHealth({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  timeRemainingPercent,
  windowMinutes: 7 * 24 * 60,
  ...thresholds
});

const onPace = assess(50, 50);
assert.equal(onPace.health, "healthy", "额度与时间进度一致时应健康");
assert.equal(onPace.currentDayEnd, 3.5);
assert.equal(onPace.usedEquivalentDays, 3.5);
assert.equal(onPace.leadDays, 0);
assert.equal(onPace.healthProgress, 0, "健康区间应保持绿色起点");

const morningOnPace = assess(30, 70);
const eveningOnPace = assess(70, 30);
assert.equal(morningOnPace.leadDays, 0, "早间按进度使用时领先天数应为 0");
assert.equal(eveningOnPace.leadDays, 0, "晚间按进度使用时领先天数应为 0");

const halfDayAhead = assess(57.14, 50);
assert.equal(halfDayAhead.health, "healthy", "提前 0.5 天仍应属于默认健康范围");
assert(Math.abs(halfDayAhead.leadDays - 0.5) < 0.001);

const attention = assess(60.71, 50);
assert.equal(attention.health, "watch", "超过半天领先后应提示关注");
assert.equal(attention.label, "需关注");
assert(
  Math.abs(attention.healthProgress - 0.5) < 0.001,
  "关注区间应位于健康与警示之间",
);

const warning = assess(64.29, 50);
assert.equal(warning.health, "critical", "领先一天时应警示");
assert.equal(warning.label, "警示");
assert.equal(warning.healthProgress, 1, "警示区间应保持橙色终点");

const customizedHealthy = assess(60.71, 50, {
  healthyLeadDays: 0.75,
  warningLeadDays: 1.5
});
assert.equal(customizedHealthy.health, "healthy", "自定义健康阈值应生效");
const customizedWatch = assess(68, 50, {
  healthyLeadDays: 0.75,
  warningLeadDays: 1.5
});
assert.equal(customizedWatch.health, "watch", "自定义警示阈值应生效");

assert.equal(
  deriveWarningLeadDays(0.25),
  0.5,
  "6 小时健康上限应自动得到 12 小时警示线"
);
assert.equal(
  deriveWarningLeadDays(1),
  2,
  "24 小时健康上限应自动得到 48 小时警示线"
);
assert.deepEqual(
  normalizeQuotaHealthThresholds({
    healthyLeadDays: 0.25,
    mode: QUOTA_HEALTH_MODE.linked
  }),
  { healthyLeadDays: 0.25, warningLeadDays: 0.5 },
  "简化模式应按健康上限翻倍生成警示线"
);
const linkedWarning = assess(64.29, 50, {
  healthyLeadDays: 0.25,
  mode: QUOTA_HEALTH_MODE.linked
});
assert.equal(linkedWarning.health, "critical", "自动生成的警示线应参与健康度判断");

assert.deepEqual(normalizeQuotaHealthThresholds(), {
  healthyLeadDays: DEFAULT_HEALTHY_LEAD_DAYS,
  warningLeadDays: DEFAULT_WARNING_LEAD_DAYS
});
assert.deepEqual(normalizeQuotaHealthThresholds({
  healthyLeadDays: 2.9,
  warningLeadDays: -1
}), {
  healthyLeadDays: 2.75,
  warningLeadDays: 3
}, "阈值应按 0.25 天取整并保持警示值大于健康值");

const unavailable = evaluateQuotaHealth({
  usedPercent: undefined,
  remainingPercent: undefined,
  timeRemainingPercent: undefined
});
assert.equal(unavailable.health, "neutral", "未同步时应保持中性态");
assert.equal(unavailable.leadDays, null);
assert.equal(unavailable.healthProgress, null);

console.log("PASS quota-health");
