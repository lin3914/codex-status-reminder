"use strict";

const assert = require("assert/strict");
const {
  fetchCodexQuota,
  fetchQuotaWithFallback,
  mergeAppServerRateLimitsUpdate,
  normalizeAppServerPayload,
  normalizeUsagePayload
} = require("../../ElectronApp/codex-quota-provider");

const proUsage = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 64,
      limit_window_seconds: 604_800,
      reset_after_seconds: 299_688,
      reset_at: 1_787_801_528
    },
    secondary_window: null
  }
};

assert.deepEqual(normalizeUsagePayload(proUsage), {
  limitId: "codex",
  limitName: null,
  planType: "pro",
  primary: {
    usedPercent: 64,
    windowDurationMins: 10_080,
    resetsAt: 1_787_801_528
  },
  secondary: null
});

const plusUsage = normalizeUsagePayload({
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 21,
      limit_window_seconds: 18_000,
      reset_at: 1_782_393_890
    },
    secondary_window: {
      used_percent: 4,
      limit_window_seconds: 604_800,
      reset_at: 1_782_980_690
    }
  }
});
assert.equal(plusUsage.primary.windowDurationMins, 300);
assert.equal(plusUsage.secondary.windowDurationMins, 10_080);
assert.equal(plusUsage.secondary.usedPercent, 4);

const appServerUsage = {
  rateLimits: {
    limitId: "fallback",
    primary: {
      usedPercent: 2,
      windowDurationMins: 300,
      resetsAt: 1_782_393_890
    }
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      planType: "pro",
      primary: {
        usedPercent: 18,
        windowDurationMins: 300,
        resetsAt: 1_782_393_890
      },
      secondary: {
        usedPercent: 41,
        windowDurationMins: 10_080,
        resetsAt: 1_782_980_690
      }
    }
  }
};
assert.equal(
  normalizeAppServerPayload(appServerUsage).secondary.usedPercent,
  41,
  "the official multi-bucket response must prefer the Codex bucket"
);

const mergedUsage = mergeAppServerRateLimitsUpdate(appServerUsage, {
  rateLimits: {
    primary: {
      usedPercent: 19,
      windowDurationMins: null,
      resetsAt: null
    },
    secondary: {
      usedPercent: 42
    },
    planType: null
  }
});
const normalizedMergedUsage = normalizeAppServerPayload(mergedUsage);
assert.equal(normalizedMergedUsage.primary.usedPercent, 19);
assert.equal(normalizedMergedUsage.primary.windowDurationMins, 300);
assert.equal(normalizedMergedUsage.primary.resetsAt, 1_782_393_890);
assert.equal(normalizedMergedUsage.secondary.usedPercent, 42);
assert.equal(normalizedMergedUsage.planType, "pro");

const unrelatedUpdate = mergeAppServerRateLimitsUpdate(mergedUsage, {
  rateLimits: {
    limitId: "codex_bengalfox",
    primary: {
      usedPercent: 99,
      windowDurationMins: 10_080,
      resetsAt: 1_782_980_690
    }
  }
});
assert.equal(
  normalizeAppServerPayload(unrelatedUpdate).secondary.usedPercent,
  42,
  "an additional quota bucket must not overwrite the weekly Codex quota"
);
assert.equal(
  unrelatedUpdate.rateLimitsByLimitId.codex_bengalfox.primary.usedPercent,
  99
);

(async () => {
  const calls = [];
  const official = new Error("official unavailable");
  const fallback = await fetchQuotaWithFallback({
    fetchOfficial: async () => {
      calls.push("official");
      throw official;
    },
    fetchCompatibility: async () => {
      calls.push("compatibility");
      return { source: "codex-usage-api" };
    }
  });
  assert.deepEqual(calls, ["official", "compatibility"]);
  assert.equal(fallback.result.source, "codex-usage-api");
  assert.equal(fallback.primaryError, official);

  calls.length = 0;
  const primary = await fetchQuotaWithFallback({
    fetchOfficial: async () => {
      calls.push("official");
      return { source: "codex-app-server" };
    },
    fetchCompatibility: async () => {
      calls.push("compatibility");
      return { source: "codex-usage-api" };
    }
  });
  assert.deepEqual(calls, ["official"]);
  assert.equal(primary.result.source, "codex-app-server");
  assert.equal(primary.primaryError, null);

  const compatibilityFailure = new Error("compatibility unavailable");
  await assert.rejects(
    fetchQuotaWithFallback({
      fetchOfficial: async () => {
        throw official;
      },
      fetchCompatibility: async () => {
        throw compatibilityFailure;
      }
    }),
    (error) => (
      error === compatibilityFailure
      && error.primaryError === official
    )
  );

  let requested = null;
  const result = await fetchCodexQuota({
    codexHome: "/portable/.codex",
    fsModule: {
      readFileSync(filePath) {
        assert.equal(filePath, "/portable/.codex/auth.json");
        return JSON.stringify({
          tokens: {
            access_token: "test-access-token",
            account_id: "test-account"
          }
        });
      }
    },
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return proUsage;
        }
      };
    }
  });
  assert.equal(
    requested.url,
    "https://chatgpt.com/backend-api/wham/usage"
  );
  assert.equal(
    requested.options.headers.Authorization,
    "Bearer test-access-token"
  );
  assert.equal(
    requested.options.headers["ChatGPT-Account-Id"],
    "test-account"
  );
  assert.equal(result.rateLimits.primary.usedPercent, 64);
  assert.equal(result.source, "codex-usage-api");
  console.log("PASS codex-quota-provider");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
