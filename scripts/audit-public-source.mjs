#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function auditPublicSource(root) {
  const excluded = new Set([".git", ".build", "node_modules"]);
  const forbiddenRoots = new Set(["deliverables", "design", ".agents", ".playwright-cli", "dist"]);
  const binaryExtensions = new Set([".png", ".icns"]);
  const findings = [];
  let files = 0;
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (item.isDirectory() && dir === root && excluded.has(item.name)) continue;
      if (item.isSymbolicLink()) { findings.push(rel + ": symlink is not allowed in the public export"); continue; }
      if (item.isDirectory()) {
        if (dir === root && forbiddenRoots.has(item.name)) findings.push(rel + ": private/generated tree");
        else visit(full);
        continue;
      }
      files++;
      if (/^(?:auth|settings|quota-cache|completion-notification-state|resource-diagnostics)\.json$/.test(item.name)
        || /\.(?:p12|pfx|pem|key|sqlite(?:-\w+)?|db|jsonl|log)$/.test(item.name)
        || /^\.env(?:\.|$)/.test(item.name)) findings.push(rel + ": sensitive file type");
      if (binaryExtensions.has(path.extname(item.name))) {
        if (!rel.startsWith("Resources/")) findings.push(rel + ": binary image outside reviewed Resources");
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      const checks = [
        [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
        [/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/, "GitHub token"],
        [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/, "API secret"],
        [/\/Users\/lindaozhi\//, "personal absolute path"],
        [/(?:bytedance\.larkoffice\.com|feishu\.cn)\/(?:docx|wiki)\//, "private document URL"],
        [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, "JWT"]
      ];
      for (const [pattern, reason] of checks) if (pattern.test(text)) findings.push(rel + ": " + reason);
    }
  }
  visit(root);
  return { files, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = auditPublicSource(root);
  console.log(JSON.stringify(result, null, 2));
  if (result.findings.length) process.exitCode = 1;
}
