#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export function addContentSecurityPolicy(html) {
  if (/<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(html)) {
    throw new Error("Source already has CSP; do not silently override it");
  }
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(match[1])) throw new Error("Unexpected external script");
    hashes.push("'sha256-" + crypto.createHash("sha256").update(match[2]).digest("base64") + "'");
  }
  const policy = [
    "default-src 'none'", "script-src " + (hashes.join(" ") || "'none'"),
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "font-src 'self'", "connect-src 'none'", "object-src 'none'",
    "frame-src 'none'", "base-uri 'none'", "form-action 'none'"
  ].join("; ");
  if (!/<head>/i.test(html)) throw new Error("HTML head missing");
  return html.replace(/<head>/i, '<head>\n  <meta http-equiv="Content-Security-Policy" content="' + policy + '">');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: harden-renderer-pages.mjs STAGED_RENDERER_DIR");
  for (const file of ["dot.html", "panel.html", "settings.html", "notification.html"]) {
    const target = path.join(dir, file);
    fs.writeFileSync(target, addContentSecurityPolicy(fs.readFileSync(target, "utf8")));
  }
}
