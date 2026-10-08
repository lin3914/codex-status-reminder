"use strict";

const MIN_THRESHOLD_STEP_DAYS = 0.25;
const DEFAULT_WINDOW_MINUTES = 7 * 24 * 60;
const DEFAULT_HEALTHY_LEAD_DAYS = 0.5;
const DEFAULT_WARNING_LEAD_DAYS = 1;
const MAX_CONFIGURABLE_LEAD_DAYS = 3;
const MAX_WARNING_LEAD_DAYS = MAX_CONFIGURABLE_LEAD_DAYS * 2;
const DEFAULT_QUOTA_HEALTH_MODE = "linked";
const QUOTA_HEALTH_MODE = Object.freeze({
  linked: "linked",
  custom: "custom"
});

const QuotaHealth = Object.freeze({
  healthy: "healthy",
  watch: "watch",
  critical: "critical",
  neutral: "neutral"
});

const labels = Object.freeze({
  [QuotaHealth.healthy]: "健康",
  [QuotaHealth.watch]: "需关注",
  [QuotaHealth.critical]: "警示",
  [QuotaHealth.neutral]: "待同步"
});

const clampPercent = (value) => Math.min(100, Math.max(0, value));

function toPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clampPercent(numeric) : null;
}

function roundToThresholdStep(value) {
  return Math.round(value / MIN_THRESHOLD_STEP_DAYS) * MIN_THRESHOLD_STEP_DAYS;
}

function normalizeHealthyLeadDays(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_HEALTHY_LEAD_DAYS;
  return Math.min(
    MAX_CONFIGURABLE_LEAD_DAYS - MIN_THRESHOLD_STEP_DAYS,
    Math.max(0, roundToThresholdStep(numeric))
  );
}

function normalizeQuotaHealthMode(value) {
  return value === QUOTA_HEALTH_MODE.custom
    ? QUOTA_HEALTH_MODE.custom
    : QUOTA_HEALTH_MODE.linked;
}

function normalizeWarningLeadDays(value, healthyLeadDays = DEFAULT_HEALTHY_LEAD_DAYS) {
  const healthy = normalizeHealthyLeadDays(healthyLeadDays);
  const numeric = Number(value);
  const requested = Number.isFinite(numeric)
    ? roundToThresholdStep(numeric)
    : DEFAULT_WARNING_LEAD_DAYS;
  return Math.min(
    MAX_WARNING_LEAD_DAYS,
    Math.max(healthy + MIN_THRESHOLD_STEP_DAYS, requested)
  );
}

/**
 * In the simplified A+B mode the warning line is derived from one user-facing
 * choice: it is twice the healthy lead. A 0-day healthy edge case keeps one
 * minimum step so the three visual states do not collapse into two states.
 */
function deriveWarningLeadDays(healthyLeadDays = DEFAULT_HEALTHY_LEAD_DAYS) {
  const healthy = normalizeHealthyLeadDays(healthyLeadDays);
  return Math.min(
    MAX_WARNING_LEAD_DAYS,
    Math.max(healthy + MIN_THRESHOLD_STEP_DAYS, roundToThresholdStep(healthy * 2))
  );
}

function normalizeQuotaHealthThresholds({
  healthyLeadDays,
  warningLeadDays,
  mode = QUOTA_HEALTH_MODE.custom
} = {}) {
  const healthy = normalizeHealthyLeadDays(healthyLeadDays);
  const normalizedMode = normalizeQuotaHealthMode(mode);
  return {
    healthyLeadDays: healthy,
    warningLeadDays: normalizedMode === QUOTA_HEALTH_MODE.linked
      ? deriveWarningLeadDays(healthy)
      : normalizeWarningLeadDays(warningLeadDays, healthy)
  };
}

/**
 * Converts the quota window into an absolute pace difference.
 *
 * `leadDays` is the number of quota days consumed ahead of the current clock:
 *
 *   used-equivalent days − elapsed time days
 *
 * A value of 0 means usage is exactly on pace. A value of 0.5 means the
 * account has consumed half a day's allowance ahead of time, regardless of
 * whether the snapshot was taken in the morning or at night.
 */
function evaluateQuotaHealth({
  usedPercent,
  remainingPercent,
  timeRemainingPercent,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  healthyLeadDays = DEFAULT_HEALTHY_LEAD_DAYS,
  warningLeadDays = DEFAULT_WARNING_LEAD_DAYS,
  mode = QUOTA_HEALTH_MODE.custom
}) {
  const used = toPercent(usedPercent);
  const suppliedRemaining = toPercent(remainingPercent);
  const timeRemaining = toPercent(timeRemainingPercent);
  const durationMinutes = Number(windowMinutes);
  const thresholds = normalizeQuotaHealthThresholds({
    healthyLeadDays,
    warningLeadDays,
    mode
  });

  if (
    used === null
    || timeRemaining === null
    || !Number.isFinite(durationMinutes)
    || durationMinutes <= 0
  ) {
    return {
      health: QuotaHealth.neutral,
      label: labels[QuotaHealth.neutral],
      usedPercent: used,
      remainingPercent: suppliedRemaining,
      timeRemainingPercent: timeRemaining,
      windowMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
      cycleDays: null,
      elapsedDays: null,
      currentDayEnd: null,
      usedEquivalentDays: null,
      leadDays: null,
      healthProgress: null,
      ...thresholds,
      description: "额度或周期时间暂未同步"
    };
  }

  const remaining = suppliedRemaining === null ? 100 - used : suppliedRemaining;
  const cycleDays = durationMinutes / 1_440;
  const elapsedDays = (100 - timeRemaining) / 100 * cycleDays;
  const usedEquivalentDays = used / 100 * cycleDays;
  const leadDays = usedEquivalentDays - elapsedDays;
  // Keep the status label discrete for copy and sorting, but expose a
  // continuous 0..1 severity value for the icon's green -> yellow -> orange
  // color interpolation. Values before the healthy threshold stay green;
  // values after the warning threshold stay orange.
  const healthSpan = Math.max(
    MIN_THRESHOLD_STEP_DAYS,
    thresholds.warningLeadDays - thresholds.healthyLeadDays
  );
  const healthProgress = Math.min(
    1,
    Math.max(0, (leadDays - thresholds.healthyLeadDays) / healthSpan)
  );

  let health = QuotaHealth.watch;
  if (leadDays <= thresholds.healthyLeadDays) {
    health = QuotaHealth.healthy;
  } else if (leadDays >= thresholds.warningLeadDays) {
    health = QuotaHealth.critical;
  }

  const roundedLead = Math.round(leadDays * 100) / 100;
  const leadDescription = roundedLead > 0
    ? `已提前使用 ${roundedLead} 天额度`
    : roundedLead < 0
      ? `比时间进度慢 ${Math.abs(roundedLead)} 天`
      : "与时间进度一致";
  return {
    health,
    label: labels[health],
    usedPercent: used,
    remainingPercent: remaining,
    timeRemainingPercent: timeRemaining,
    windowMinutes: durationMinutes,
    cycleDays,
    elapsedDays,
    // Kept for read-only compatibility with older settings consumers. New
    // health decisions use elapsedDays and leadDays only.
    currentDayEnd: elapsedDays,
    usedEquivalentDays,
    leadDays,
    healthProgress,
    ...thresholds,
    description: `额度已用 ${Math.round(used)}%，${leadDescription}`
  };
}

module.exports = {
  DEFAULT_HEALTHY_LEAD_DAYS,
  DEFAULT_WARNING_LEAD_DAYS,
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_QUOTA_HEALTH_MODE,
  MAX_CONFIGURABLE_LEAD_DAYS,
  MAX_WARNING_LEAD_DAYS,
  MIN_THRESHOLD_STEP_DAYS,
  QUOTA_HEALTH_MODE,
  QuotaHealth,
  deriveWarningLeadDays,
  evaluateQuotaHealth,
  normalizeHealthyLeadDays,
  normalizeQuotaHealthMode,
  normalizeQuotaHealthThresholds,
  normalizeWarningLeadDays
};
