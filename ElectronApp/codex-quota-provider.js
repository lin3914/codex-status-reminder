"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 12_000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWindow(source) {
  if (!source || typeof source !== "object") return null;
  const usedPercent = finiteNumber(
    source.usedPercent
      ?? source.used_percent
  );
  const windowDurationMins = finiteNumber(
    source.windowDurationMins
      ?? source.window_duration_mins
      ?? source.windowMinutes
      ?? source.window_minutes
  ) ?? (() => {
    const seconds = finiteNumber(
      source.limitWindowSeconds
        ?? source.limit_window_seconds
        ?? source.windowSeconds
        ?? source.window_seconds
    );
    return seconds === null ? null : seconds / 60;
  })();
  const resetsAt = finiteNumber(
    source.resetsAt
      ?? source.resets_at
      ?? source.resetAt
      ?? source.reset_at
  );
  if (usedPercent === null || windowDurationMins === null) return null;
  return {
    usedPercent,
    windowDurationMins,
    resetsAt
  };
}

function normalizeRateLimitBucket(bucket, {
  limitId = "codex",
  planType = null
} = {}) {
  if (!bucket || typeof bucket !== "object") return null;
  const primary = normalizeWindow(
    bucket.primary
      ?? bucket.primary_window
      ?? bucket.primaryWindow
  );
  const secondary = normalizeWindow(
    bucket.secondary
      ?? bucket.secondary_window
      ?? bucket.secondaryWindow
  );
  if (!primary && !secondary) return null;
  return {
    limitId: bucket.limitId ?? bucket.limit_id ?? limitId,
    limitName: bucket.limitName ?? bucket.limit_name ?? null,
    planType: bucket.planType ?? bucket.plan_type ?? planType,
    primary,
    secondary
  };
}

function normalizeUsagePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const planType = payload.planType ?? payload.plan_type ?? null;
  const preferred = normalizeRateLimitBucket(
    payload.rateLimits
      ?? payload.rate_limits
      ?? payload.rateLimit
      ?? payload.rate_limit,
    { planType }
  );
  if (preferred) return preferred;

  const additional = payload.additionalRateLimits
    ?? payload.additional_rate_limits
    ?? [];
  const buckets = Array.isArray(additional)
    ? additional
    : Object.values(additional || {});
  for (const bucket of buckets) {
    const normalized = normalizeRateLimitBucket(bucket, {
      limitId: bucket?.limit_id ?? bucket?.limitId ?? "codex",
      planType
    });
    if (normalized?.limitId === "codex") return normalized;
  }
  return null;
}

function normalizeAppServerPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const byLimitId = payload.rateLimitsByLimitId
    ?? payload.rate_limits_by_limit_id;
  const preferred = byLimitId?.codex
    ?? payload.rateLimits
    ?? payload.rate_limits;
  return normalizeRateLimitBucket(preferred, {
    limitId: preferred?.limitId ?? preferred?.limit_id ?? "codex",
    planType: preferred?.planType ?? preferred?.plan_type ?? null
  });
}

function mergeSparseObject(base, patch) {
  const left = base && typeof base === "object" && !Array.isArray(base)
    ? base
    : {};
  const right = patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch
    : {};
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    // Rolling rate-limit updates deliberately use null for unavailable account
    // metadata. A sparse update must not erase a value from the last full read.
    if (value === null || value === undefined) continue;
    result[key] = (
      typeof value === "object"
      && !Array.isArray(value)
      && typeof left[key] === "object"
      && !Array.isArray(left[key])
    )
      ? mergeSparseObject(left[key], value)
      : value;
  }
  return result;
}

function mergeAppServerRateLimitsUpdate(previous, notification) {
  const update = notification?.rateLimits
    ?? notification?.rate_limits;
  if (!update || typeof update !== "object") return previous || null;
  const base = previous && typeof previous === "object" ? previous : {};
  const historical = base.rateLimits ?? base.rate_limits;
  const existingByLimitId = base.rateLimitsByLimitId
    ?? base.rate_limits_by_limit_id;
  const limitId = update.limitId
    ?? update.limit_id
    ?? (existingByLimitId?.codex ? "codex" : null)
    ?? historical?.limitId
    ?? historical?.limit_id
    ?? "codex";
  const isCodexLimit = limitId === "codex";
  const rateLimits = isCodexLimit
    ? mergeSparseObject(historical, update)
    : historical;
  const rateLimitsByLimitId = existingByLimitId || !isCodexLimit
    ? {
      ...(existingByLimitId || {}),
      [limitId]: mergeSparseObject(existingByLimitId?.[limitId], update)
    }
    : null;
  return {
    ...base,
    ...(rateLimits ? { rateLimits } : {}),
    ...(rateLimitsByLimitId ? { rateLimitsByLimitId } : {})
  };
}

function readCodexAuth(codexHome, fsModule = fs) {
  const authPath = path.join(codexHome, "auth.json");
  const root = JSON.parse(fsModule.readFileSync(authPath, "utf8"));
  const accessToken = root?.tokens?.access_token;
  const accountId = root?.tokens?.account_id;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("Codex access token is unavailable");
  }
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Codex account ID is unavailable");
  }
  return { accessToken, accountId };
}

async function fetchCodexQuota({
  codexHome,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_USAGE_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fsModule = fs
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Network fetch is unavailable");
  }
  const { accessToken, accountId } = readCodexAuth(codexHome, fsModule);
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Codex usage request failed (${response.status})`);
  }
  const payload = await response.json();
  const rateLimits = normalizeUsagePayload(payload);
  if (!rateLimits) {
    throw new Error("Codex usage response did not include a quota window");
  }
  return {
    rateLimits,
    fetchedAt: Date.now(),
    source: "codex-usage-api"
  };
}

async function fetchQuotaWithFallback({
  fetchOfficial,
  fetchCompatibility
}) {
  try {
    return {
      result: await fetchOfficial(),
      primaryError: null
    };
  } catch (primaryError) {
    try {
      return {
        result: await fetchCompatibility(),
        primaryError
      };
    } catch (compatibilityError) {
      const finalError = compatibilityError instanceof Error
        ? compatibilityError
        : new Error(String(compatibilityError));
      finalError.primaryError = primaryError;
      throw finalError;
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USAGE_ENDPOINT,
  fetchCodexQuota,
  fetchQuotaWithFallback,
  mergeAppServerRateLimitsUpdate,
  mergeSparseObject,
  normalizeAppServerPayload,
  normalizeRateLimitBucket,
  normalizeUsagePayload,
  normalizeWindow,
  readCodexAuth
};
