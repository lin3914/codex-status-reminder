#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const dependencies = Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) => ({
  name: key.replace(/^node_modules\//, ""),
  version: value.version,
  license: value.license || "UNKNOWN",
  role: value.dev ? "build-only dependency" : "runtime dependency"
}));
if (dependencies.some(item => item.license === "UNKNOWN")) throw new Error("Missing license metadata; review before release");
fs.mkdirSync(path.join(root, "licenses"), { recursive: true });
fs.writeFileSync(path.join(root, "licenses/build-dependencies.json"), JSON.stringify({
  source: "package-lock.json metadata; full upstream license texts govern",
  electron: lock.packages["node_modules/electron"].version,
  dependencies
}, null, 2) + "\n");
console.log("Generated build dependency license inventory: " + dependencies.length);
