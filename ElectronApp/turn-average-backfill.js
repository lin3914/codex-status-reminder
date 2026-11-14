"use strict";

// Cold-start recovery for one turn only. Walk backwards in bounded chunks,
// retaining counters/boundaries rather than tool output or conversation text.
const CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const timestamp = value => typeof value === "number"
  ? value < 1e12 ? value * 1000 : value : Date.parse(value) || 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

class TurnAverageBackfill {
  constructor({ endOffset, endedAt = 0, turnId = null }) {
    this.cursor = endOffset;
    this.endedAt = endedAt;
    this.turnId = turnId;
    this.fragment = "";
    this.skipping = false;
    this.startedAt = 0;
    this.firstUsage = null;
    this.latestTotal = null;
    this.newerTotal = null;
    this.invalid = false;
    this.done = false;
    this.result = null;
  }

  consume(line) {
    if (this.done || line.length > MAX_RECORD_BYTES || !line.includes("event_msg")) return;
    let root;
    try { root = JSON.parse(line); } catch { return; }
    if (root?.type !== "event_msg") return;
    const p = root.payload || {}, at = timestamp(root.timestamp);
    if (!at || (this.endedAt && at > this.endedAt)) return;
    if (p.type === "task_started") {
      if (this.startedAt) { this.finish(); return; }
      if (this.turnId && p.turn_id && p.turn_id !== this.turnId) {
        this.invalid = true; this.finish(); return;
      }
      this.startedAt = at;
      return;
    }
    if (p.type !== "token_count") return;
    const total = count(p.info?.total_token_usage?.output_tokens);
    if (total === null) return;
    if (this.startedAt) { this.finish(total); return; }
    if (this.newerTotal !== null && total > this.newerTotal) this.invalid = true;
    if (this.latestTotal === null) this.latestTotal = total;
    this.newerTotal = total;
    this.firstUsage = { total, last: count(p.info?.last_token_usage?.output_tokens) };
  }

  finish(baseline = null) {
    if (this.done) return;
    if (baseline === null && this.firstUsage?.last !== null && this.firstUsage) {
      baseline = this.firstUsage.total - this.firstUsage.last;
    }
    const invalid = this.invalid || !this.startedAt || baseline === null || baseline < 0
      || (this.firstUsage && baseline > this.firstUsage.total);
    this.result = { startedAt: this.startedAt, baselineOutput: baseline,
      latestTotal: this.latestTotal, invalid: Boolean(invalid) };
    this.done = true;
    this.fragment = "";
  }

  step(filePath, budget, readRange) {
    let used = 0;
    while (!this.done && this.cursor > 0 && used < budget) {
      const start = Math.max(0, this.cursor - Math.min(CHUNK_BYTES, budget - used));
      const bytes = readRange(filePath, start, this.cursor);
      if (!bytes.length) { this.invalid = true; this.finish(); break; }
      this.cursor = start; used += bytes.length;
      const parts = bytes.toString("utf8").split("\n"), prefix = parts.shift();
      if (parts.length) {
        for (let i = parts.length - 1; i >= 0 && !this.done; i--) {
          if (i === parts.length - 1) {
            if (!this.skipping) this.consume(parts[i] + this.fragment);
          } else this.consume(parts[i]);
        }
        if (!this.done) { this.fragment = prefix; this.skipping = false; }
      } else if (!this.skipping && !this.done) this.fragment = prefix + this.fragment;
      if (this.fragment.length > MAX_RECORD_BYTES) { this.fragment = ""; this.skipping = true; }
      if (!this.cursor && !this.done) {
        if (!this.skipping) this.consume(this.fragment);
        if (!this.done) this.finish();
      }
    }
    return used;
  }
}

module.exports = { TurnAverageBackfill, CHUNK_BYTES, MAX_RECORD_BYTES };
