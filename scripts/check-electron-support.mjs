#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function electronSupport(releases, current) {
  const versionParts = v => v.split(".").map(Number);
  const stable = releases.filter(r => /^\d+\.\d+\.\d+$/.test(r.version)).sort((a,b) => {
    const x=versionParts(a.version), y=versionParts(b.version);
    return y[0]-x[0] || y[1]-x[1] || y[2]-x[2];
  });
  const majors = [...new Set(stable.map(r => versionParts(r.version)[0]))].slice(0,3);
  const major = versionParts(current)[0];
  const latestOnLine = stable.find(r => versionParts(r.version)[0] === major)?.version;
  return { current, supportedMajors: majors, latestOnLine, supported: majors.includes(major), currentPatch: current === latestOnLine };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const response = await fetch("https://releases.electronjs.org/releases.json", { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error("Official Electron release index unavailable");
    const result = electronSupport(await response.json(), pkg.devDependencies.electron);
    console.log(JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2));
    if (!result.supported || !result.currentPatch) {
      console.error("Binary release requires a supported line's latest patch, with its own regression verification.");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error("Cannot verify Electron release policy: " + error.message);
    process.exitCode = 2;
  }
}
