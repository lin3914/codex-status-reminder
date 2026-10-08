#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only generated children of this checkout's .build may be replaced.
// Resolve existing ancestors to reject symlink escapes as well as ../ paths.
export function validateBuildPath(project, target) {
  const root = fs.realpathSync(project);
  const build = path.join(root, ".build");
  const resolved = path.resolve(target);
  const lexicalBuild = path.join(path.resolve(project), ".build");
  if (!resolved.startsWith(lexicalBuild + path.sep) && !resolved.startsWith(build + path.sep)) {
    throw new Error("Output must be a child of the checkout's .build directory");
  }
  let parent = resolved;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const physical = fs.realpathSync(parent);
  const physicalTarget = path.join(physical, path.relative(parent, resolved));
  if (!physicalTarget.startsWith(build + path.sep)) {
    throw new Error("Output follows a symlink outside .build");
  }
  if (fs.existsSync(build) && fs.realpathSync(build) !== build) throw new Error(".build must not be a symlink");
  return resolved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [project, ...targets] = process.argv.slice(2);
    if (!project || !targets.length) throw new Error("Usage: validate-build-paths.mjs PROJECT OUTPUT...");
    for (const target of targets) validateBuildPath(project, target);
  } catch (error) {
    console.error("Unsafe build output: " + error.message);
    process.exitCode = 2;
  }
}
