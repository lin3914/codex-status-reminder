"use strict";

const { createHash } = require("crypto");

function scopeHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// This decodes only the local account selector; it does not authenticate,
// refresh, transmit, or persist tokens. Never return token contents to callers.
function unreadIdentityKey(auth) {
  const mode = auth?.auth_mode;
  if (mode === "chatgpt" || mode === "chatgptAuthTokens") {
    const token = auth?.tokens?.access_token || auth?.tokens?.id_token;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
      const claims = payload["https://api.openai.com/auth"];
      const accountId = claims?.chatgpt_account_id ?? claims?.account_id;
      const userId = claims?.user_id ?? claims?.chatgpt_user_id;
      if (typeof accountId !== "string" || !accountId
        || typeof userId !== "string" || !userId) return null;
      return scopeHash(["chatgpt", accountId, userId]);
    } catch {
      return null;
    }
  }
  if (typeof mode === "string" && mode) {
    return scopeHash(["execution-storage", mode]);
  }
  return null;
}

function localUnreadHostKey(environment = process.env) {
  const websocketURL = environment.CODEX_APP_SERVER_FORCE_CLI === "1"
    ? null : environment.CODEX_APP_SERVER_WS_URL || null;
  return `local:${scopeHash(["local", "local", websocketURL])}`;
}

function cleanUnreadIds(values) {
  return [...new Set(values.filter((id) => typeof id === "string")
    .map((id) => id.trim()).filter(Boolean))];
}

function extractUnreadState(root, {
  identityKey = null,
  hostKey = localUnreadHostKey()
} = {}) {
  const unavailable = { ids: [], available: false };
  // A new-format empty set is authoritative. Never resurrect the migration
  // backup or union another account / execution host into the current set.
  if (Object.hasOwn(root || {}, "electron-thread-read-state-v1")) {
    const state = root["electron-thread-read-state-v1"];
    if (state?.version !== 1 || !identityKey) return unavailable;
    const local = state.unreadByIdentity?.[identityKey]?.[hostKey];
    return Array.isArray(local)
      ? { ids: cleanUnreadIds(local), available: true } : unavailable;
  }
  const state = root?.["electron-persisted-atom-state"];
  if (!state || typeof state !== "object") return unavailable;
  const candidates = [
    state["unread-thread-ids-by-host-v1"]?.local,
    state["unread-thread-ids-by-host-v2"]?.local,
    state["unread-thread-ids-v1"],
    state["unread-thread-ids"]
  ];
  const values = candidates.filter(Array.isArray).flat();
  return { ids: cleanUnreadIds(values), available: candidates.some(Array.isArray) };
}

function extractUnreadThreadIds(root, options) {
  return extractUnreadState(root, options).ids;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildThreadQuery(columnNames, unreadThreadIds, limit = 120) {
  const columns = new Set(columnNames);
  if (!columns.has("id") || !columns.has("rollout_path")) return null;
  const has = (name) => columns.has(name);
  const text = (name, fallback = "''") => has(name)
    ? `COALESCE(${name}, '')`
    : fallback;
  const nullableText = (name) => has(name) ? `NULLIF(${name}, '')` : "NULL";
  const updated = has("updated_at_ms")
    ? "updated_at_ms"
    : has("updated_at") ? "updated_at * 1000" : "0";
  const recencyParts = [];
  if (has("recency_at_ms")) recencyParts.push("NULLIF(recency_at_ms, 0)");
  if (has("recency_at")) recencyParts.push("NULLIF(recency_at * 1000, 0)");
  recencyParts.push(updated);
  const recency = `COALESCE(${recencyParts.join(", ")})`;
  const titleParts = ["name", "title", "preview", "first_user_message"]
    .filter(has)
    .map(nullableText);
  titleParts.push("'Codex 会话'");
  const displayTitle = `COALESCE(${titleParts.join(", ")})`;
  const filters = [];
  if (has("archived")) filters.push("COALESCE(archived, 0) = 0");
  if (has("thread_source")) {
    filters.push("LOWER(COALESCE(thread_source, '')) NOT LIKE 'subagent%'");
  }
  if (has("source")) {
    filters.push("LOWER(COALESCE(source, '')) NOT LIKE '%\"subagent\"%'");
  }
  const where = filters.length > 0 ? filters.join("\n         AND ") : "1 = 1";
  const unreadIds = unreadThreadIds
    .filter((id) => typeof id === "string" && /^[0-9a-f-]{20,}$/i.test(id))
    .map(sqlString);
  const unreadClause = unreadIds.length > 0
    ? `OR id IN (${unreadIds.join(",")})`
    : "";
  const safeLimit = Math.max(10, Math.min(500, Number(limit) || 120));
  return `
    WITH recent_threads AS (
      SELECT id
        FROM threads
       WHERE ${where}
       ORDER BY ${recency} DESC
       LIMIT ${safeLimit}
    )
    SELECT id,
           rollout_path,
           ${displayTitle} AS display_title,
           ${text("preview")} AS preview,
           ${updated} AS updated_at_ms,
           ${recency} AS recency_at_ms,
           ${text("cwd")} AS cwd,
           ${text("thread_source")} AS thread_source,
           ${text("source")} AS source,
           ${text("agent_path")} AS agent_path,
           ${has("archived") ? "COALESCE(archived, 0)" : "0"} AS archived
      FROM threads
     WHERE ${where}
       AND (
         id IN (SELECT id FROM recent_threads)
         ${unreadClause}
       )
     ORDER BY ${recency} DESC
  `;
}

function buildChangedThreadQuery(columnNames, afterMs, limit = 500) {
  const columns = new Set(columnNames);
  if (!columns.has("id") || !columns.has("rollout_path")) return null;
  const has = (name) => columns.has(name);
  const text = (name, fallback = "''") => has(name)
    ? `COALESCE(${name}, '')`
    : fallback;
  const nullableText = (name) => has(name) ? `NULLIF(${name}, '')` : "NULL";
  const updated = has("updated_at_ms")
    ? "updated_at_ms"
    : has("updated_at") ? "updated_at * 1000" : "0";
  const recencyParts = [];
  if (has("recency_at_ms")) recencyParts.push("NULLIF(recency_at_ms, 0)");
  if (has("recency_at")) recencyParts.push("NULLIF(recency_at * 1000, 0)");
  recencyParts.push(updated);
  const recency = `COALESCE(${recencyParts.join(", ")})`;
  const titleParts = ["name", "title", "preview", "first_user_message"]
    .filter(has)
    .map(nullableText);
  titleParts.push("'Codex 会话'");
  const displayTitle = `COALESCE(${titleParts.join(", ")})`;
  const safeAfterMs = Math.max(0, Math.floor(Number(afterMs) || 0));
  const safeLimit = Math.max(10, Math.min(2_000, Number(limit) || 500));
  return `
    SELECT id,
           rollout_path,
           ${displayTitle} AS display_title,
           ${text("preview")} AS preview,
           ${updated} AS updated_at_ms,
           ${recency} AS recency_at_ms,
           ${text("cwd")} AS cwd,
           ${text("thread_source")} AS thread_source,
           ${text("source")} AS source,
           ${text("agent_path")} AS agent_path,
           ${has("archived") ? "COALESCE(archived, 0)" : "0"} AS archived
      FROM threads
     WHERE ${updated} > ${safeAfterMs}
     ORDER BY ${updated} ASC
     LIMIT ${safeLimit}
  `;
}

module.exports = {
  buildChangedThreadQuery,
  buildThreadQuery,
  extractUnreadThreadIds,
  extractUnreadState,
  localUnreadHostKey,
  unreadIdentityKey
};
