import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import security from "../../ElectronApp/renderer-security.js";
import { addContentSecurityPolicy } from "../../scripts/harden-renderer-pages.mjs";
const { rendererURL, protectRendererWindow, trustedRendererEvent } = security;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedURL = rendererURL("/app with spaces", "panel.html");
const wc = new EventEmitter();
wc.mainFrame = { url: expectedURL };
wc.getURL = () => expectedURL;
wc.setWindowOpenHandler = handler => { wc.openHandler = handler; };
const win = { webContents: wc, isDestroyed: () => false };
protectRendererWindow(win, expectedURL);
assert.deepEqual(wc.openHandler({ url: "https://example.com" }), { action: "deny" });
for (const eventName of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
  let prevented = false;
  wc.emit(eventName, { preventDefault() { prevented = true; } }, "https://example.com");
  assert(prevented, eventName + " must be blocked");
}
const event = { sender: wc, senderFrame: wc.mainFrame };
assert.equal(trustedRendererEvent(event, win, expectedURL), true);
assert.equal(trustedRendererEvent({ sender: wc }, win, expectedURL), false);
assert.equal(trustedRendererEvent({ ...event, senderFrame: { url: expectedURL } }, win, expectedURL), false);
assert.equal(trustedRendererEvent({ ...event, sender: new EventEmitter() }, win, expectedURL), false);
assert.equal(trustedRendererEvent(event, { ...win, isDestroyed: () => true }, expectedURL), false);
wc.mainFrame.url = "https://example.com";
assert.equal(trustedRendererEvent(event, win, expectedURL), false);
for (const file of ["dot.html", "panel.html", "settings.html", "notification.html"]) {
  const html = fs.readFileSync(path.join(root, "Resources/LegacyV11", file), "utf8");
  const hardened = addContentSecurityPolicy(html);
  assert(hardened.includes("connect-src 'none'"));
  assert(!hardened.includes("unsafe-eval"));
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const hash = crypto.createHash("sha256").update(script[1]).digest("base64");
    assert(hardened.includes("'sha256-" + hash + "'"));
  }
  assert.throws(() => addContentSecurityPolicy(hardened));
  assert.equal(hardened.replace(/\n  <meta http-equiv="Content-Security-Policy"[^>]*>/, ""), html, "CSP must not alter UI content");
}
console.log("PASS renderer-security: main-frame IPC, navigation, new-window guards, hashed CSP, unchanged UI");
