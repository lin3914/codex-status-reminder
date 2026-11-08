"use strict";

// Local usage reports are batched, not a token-by-token stream. Keep exact
// reported output deltas on a common wall-clock window; never estimate tokens
// from text length or add reasoning twice (it is included in output_tokens).
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
    samples: [], coverageSince: 0, samplesTruncatedAt: 0, completeStart: false, hasUsage: false, invalid: false, phase: "waiting", model: "" };
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
    Object.assign(s, emptySpeed(), { startedAt: at, coverageSince: at, completeStart: true, model, previous });
  } else if (root.type === "event_msg" && p.type === "token_count") {
    const total = counter(p.info?.total_token_usage?.output_tokens);
    const last = counter(p.info?.last_token_usage?.output_tokens);
    if (total === null || at < s.startedAt) return;
    if (s.endedAt) { if (total !== s.previous) s.invalid = true; return; }
    if (s.previous !== null && total < s.previous) { s.invalid = true; s.previous = total; return; }
    if (s.previous === total) return;
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
  if (!running) return { kind: "average", phase: "ended", value:
    s.completeStart && s.hasUsage && !s.invalid && s.endedAt && s.durationMs > 0
      ? s.output * 1000 / s.durationMs : null };
  const windowMs = normalizeWindowSeconds(windowSeconds) * 1000;
  const incomplete = (!s.completeStart && s.coverageSince > now - windowMs)
    || s.samplesTruncatedAt > now - windowMs;
  const samples = !s.endedAt && !s.invalid && !incomplete
    ? s.samples.filter(sample => sample.at > now - windowMs && sample.at <= now) : [];
  return { kind: "live", phase: s.phase, value: samples.length
    ? samples.reduce((sum, sample) => sum + sample.output, 0) * 1000 / windowMs : null,
    sampledAt: samples.at(-1)?.at || null };
}
function speedPanel(tasks, locale = "zh-CN", now = Date.now(), windowSeconds = 30) {
  const en = locale === "en";
  const seconds = normalizeWindowSeconds(windowSeconds);
  const windowLabel = en ? `${seconds}s` : seconds < 60 ? `${seconds}秒` : `${seconds / 60}分钟`;
  const format = value => value === null ? "—" : value.toFixed(1);
  const rows = tasks.map(task => {
    const rate = rateFor(task.tokenSpeed, task.state === "running", now, seconds);
    const status = rate.kind === "live" && rate.phase === "tool" ? (en ? "Running tool" : "执行工具中")
      : rate.value !== null ? ""
        : rate.kind === "average" ? (en ? "Insufficient samples" : "样本不足")
        : (en ? "Waiting for usage" : "等待用量");
    return { ...rate, label: rate.kind === "live" ? (en ? "Live" : "实时") : (en ? "Average" : "平均"),
      text: `${format(rate.value)} tok/s`, status,
      description: rate.kind === "live"
        ? (en ? `Reported output tokens in the last ${windowLabel} / ${windowLabel}; includes reasoning; updates in batches. Old samples expire.`
          : `近${windowLabel}已上报的输出Token÷${windowLabel}，包含思考Token；用量分批更新，旧样本到期后不再显示。`)
        : (en ? "Latest fully observed turn: output tokens / full elapsed time, including tools and waiting; excludes idle between user messages."
          : "最近一轮完整运行：输出Token÷该轮全部耗时，含思考、工具与等待，不含用户两次发消息间的空闲。") };
  });
  const live = rows.filter((_, i) => tasks[i].state === "running");
  const sampled = live.filter(row => row.value !== null);
  const value = live.length === 0 ? 0 : sampled.length ? sampled.reduce((sum, row) => sum + row.value, 0) : null;
  return { rows, total: { text: `${format(value)} tok/s`, label: en ? "Live throughput" : "整体实时有效速率",
    detail: live.length === 0 ? (en ? "No active sessions" : "暂无进行中会话")
      : `${sampled.length}/${live.length} ${en ? "sessions reporting" : "会话已上报"}`,
    description: en ? `Sum of reported output throughput over the last ${windowLabel} of currently active sessions only. Ended sessions are excluded immediately.`
      : `仅汇总当前进行中会话近${windowLabel}已上报输出的速率；已结束会话立即移出。包含思考Token，用量上报存在延迟。` } };
}
module.exports = { WINDOW_MS, WINDOW_SECONDS, MAX_WINDOW_MS, normalizeWindowSeconds, emptySpeed, observeSpeed, rateFor, speedPanel };
