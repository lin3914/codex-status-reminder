"use strict";

// Local usage reports are batched, not a token-by-token stream. Keep exact
// reported output deltas on the selected window at the latest report. Hold
// that reference between batches; never invent tokens from text length or
// add reasoning twice (it is included in output_tokens).
const WINDOW_MS = 30_000;
const WINDOW_SECONDS = Object.freeze([30, 60, 300]);
const MAX_WINDOW_MS = 300_000;
const MAX_SAMPLES = 4096;
const normalizeWindowSeconds = value => WINDOW_SECONDS.includes(Number(value)) ? Number(value) : 30;
const TERMINAL = /^(?:task_complete|(?:turn|task)_(?:aborted|cancelled|canceled|failed|interrupted|paused|stopped))$/;
const time = value => typeof value === "number" ? (Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : 0) : Date.parse(value) || 0;
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function emptySpeed() {
  return { startedAt: 0, endedAt: 0, durationMs: 0, output: 0, previous: null,
    samples: [], coverageSince: 0, samplesTruncatedAt: 0, completeStart: false, hasUsage: false, invalid: false,
    historyPending: false, turnAverage: null, turnId: null, phase: "waiting", model: "" };
}
function observeSpeed(s, root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) return;
  const p = root.payload || {}, at = time(root.timestamp);
  if (!at) return;
  if (!s.coverageSince) s.coverageSince = at;
  if (root.type === "turn_context") { if (typeof p.model === "string") s.model = p.model; return; }
  if (root.type === "event_msg" && p.type === "task_started") {
    if (at <= s.startedAt || at < s.endedAt) return;
    const model = s.model, previous = s.previous;
    Object.assign(s, emptySpeed(), { startedAt: at, coverageSince: at, completeStart: true, model, previous, turnId: p.turn_id || null });
  } else if (root.type === "event_msg" && p.type === "token_count") {
    const total = counter(p.info?.total_token_usage?.output_tokens);
    const last = counter(p.info?.last_token_usage?.output_tokens);
    if (total === null || at < s.startedAt) return;
    if (s.endedAt) { if (total !== s.previous) s.invalid = true; return; }
    if (s.previous !== null && total < s.previous) { s.invalid = true; s.previous = total; return; }
    if (s.previous === total && s.hasUsage) return;
    const delta = s.previous === null ? last : total - s.previous;
    s.previous = total;
    if (delta === null || delta > total) { s.invalid = true; return; }
    s.hasUsage = true; s.output += delta;
    s.samples.push({ at, output: delta });
    s.samples = s.samples.filter(sample => sample.at >= at - MAX_WINDOW_MS);
    if (s.samples.length > MAX_SAMPLES) {
      s.samplesTruncatedAt = s.samples[s.samples.length - MAX_SAMPLES - 1].at;
      s.samples = s.samples.slice(-MAX_SAMPLES);
    }
    if (s.phase !== "tool") s.phase = "sampled";
  } else if (root.type === "event_msg" && TERMINAL.test(p.type)) {
    if (at < s.startedAt) return;
    s.endedAt = Math.max(at, time(p.completed_at), time(p.ended_at));
    s.turnId = p.turn_id || s.turnId;
    s.durationMs = Number.isFinite(p.duration_ms) && p.duration_ms > 0
      ? p.duration_ms : s.startedAt > 0 ? s.endedAt - s.startedAt : 0;
    s.phase = "ended";
  } else if (root.type === "response_item" && !s.endedAt) {
    if (["function_call", "custom_tool_call", "web_search_call"].includes(p.type)) s.phase = "tool";
    if (["function_call_output", "custom_tool_call_output"].includes(p.type)) s.phase = "waiting";
  }
}
function rateFor(s, running, now = Date.now(), windowSeconds = 30) {
  if (!s) return { kind: running ? "live" : "average", value: null, phase: "unavailable" };
  if (!running) {
    const recovered = s.turnAverage;
    const startedAt = s.completeStart ? s.startedAt : recovered?.startedAt;
    const duration = s.durationMs || (startedAt && s.endedAt ? s.endedAt - startedAt : 0);
    const output = s.completeStart ? s.output
      : recovered && !recovered.invalid && Number.isSafeInteger(s.previous)
        ? s.previous - recovered.baselineOutput : null;
    return { kind: "average", phase: "ended", value:
      (s.completeStart || (recovered && !recovered.invalid)) && s.hasUsage && !s.invalid
        && s.endedAt && duration > 0 && output !== null && output >= 0
        ? output * 1000 / duration : null };
  }
  const windowMs = normalizeWindowSeconds(windowSeconds) * 1000;
  const available = !s.endedAt && !s.invalid ? s.samples || [] : [];
  let reportedAt = 0;
  for (const sample of available) if (sample.at <= now) reportedAt = Math.max(reportedAt, sample.at);
  const referenceAt = Math.max(reportedAt,
    !s.completeStart && s.coverageSince ? s.coverageSince + windowMs : 0,
    s.samplesTruncatedAt ? s.samplesTruncatedAt + windowMs : 0);
  let output = 0, hasSamples = false;
  if (referenceAt <= now) for (const sample of available) {
    if (sample.at > referenceAt - windowMs && sample.at <= now) {
      output += sample.output;
      hasSamples = true;
    }
  }
  const value = hasSamples ? output * 1000 / windowMs : null;
  return { kind: "live", phase: s.phase, value,
    held: value !== null && now - reportedAt >= windowMs,
    sampledAt: value !== null ? reportedAt : null };
}
function nextSpeedUpdateDelay(tasks, now = Date.now(), windowSeconds = 30) {
  const windowMs = normalizeWindowSeconds(windowSeconds) * 1000;
  let next = Infinity;
  for (const task of tasks) {
    const s = task.tokenSpeed;
    if (task.state !== "running" || !s || s.endedAt || s.invalid) continue;
    for (const sample of s.samples || []) if (sample.at > now) next = Math.min(next, sample.at);
    if (!s.completeStart && s.coverageSince > now - windowMs) {
      next = Math.min(next, s.coverageSince + windowMs);
    }
    if (s.samplesTruncatedAt > now - windowMs) {
      next = Math.min(next, s.samplesTruncatedAt + windowMs);
    }
  }
  // Age alone no longer changes visible text. Only incomplete coverage or
  // future-dated records need a display wake; usage arrives through the
  // existing file events / adaptive metadata safety check.
  return Number.isFinite(next) ? Math.min(MAX_WINDOW_MS, Math.max(1000, Math.ceil(next - now + 1))) : null;
}
function speedPanel(tasks, locale = "zh-CN", now = Date.now(), windowSeconds = 30) {
  const en = locale === "en";
  const seconds = normalizeWindowSeconds(windowSeconds);
  const format = value => value === null ? "—" : value.toFixed(1);
  const rows = tasks.map(task => {
    const rate = rateFor(task.tokenSpeed, task.state === "running", now, seconds);
    const status = rate.kind === "live" && rate.phase === "tool" ? (en ? "Running tool" : "执行工具中")
      : rate.value !== null ? ""
        : rate.kind === "average" ? task.tokenSpeed?.historyPending
          ? (en ? "Loading this turn's records" : "正在补齐本轮记录") : (en ? "Insufficient samples" : "样本不足")
        : (en ? "Waiting for usage" : "等待用量");
    return { ...rate, label: rate.kind === "live" ? "" : (en ? "Average" : "平均"),
      text: `${format(rate.value)} tok/s`, status,
      description: rate.kind === "live"
        ? (en ? "Best available rate for this active task; updates when usage arrives."
          : "当前任务可用的最近速率；收到新用量后更新。")
        : (en ? "Latest fully observed turn: output tokens / full elapsed time, including tools and waiting; excludes idle between user messages."
          : "最近一轮完整运行：输出Token÷该轮全部耗时，含思考、工具与等待，不含用户两次发消息间的空闲。") };
  });
  const live = rows.filter((_, i) => tasks[i].state === "running");
  const sampled = live.filter(row => row.value !== null);
  const held = sampled.filter(row => row.held).length;
  const value = live.length === 0 ? 0 : sampled.length ? sampled.reduce((sum, row) => sum + row.value, 0) : null;
  return { rows, total: { text: `${format(value)} tok/s`, held: held > 0, label: en ? "Active task throughput" : "进行中任务速率",
    detail: live.length === 0 ? (en ? "No active sessions" : "暂无进行中会话")
      : `${sampled.length}/${live.length} ${en ? "sessions available" : "会话有速率"}`,
    description: en ? "Combined best available rates of active tasks only. Finished tasks are excluded."
      : "当前进行中任务可用速率的合计；已结束任务不计入。" } };
}
module.exports = { WINDOW_MS, WINDOW_SECONDS, MAX_WINDOW_MS, normalizeWindowSeconds, emptySpeed, observeSpeed, rateFor, nextSpeedUpdateDelay, speedPanel };
