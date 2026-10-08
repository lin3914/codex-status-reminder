#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function publicationErrors(root, mode = "source") {
  if (!["source", "binary"].includes(mode)) return ["Unknown publication mode"];
  const policy = JSON.parse(fs.readFileSync(path.join(root, "publication-policy.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const errors = [];
  for (const key of ["rightsConfirmed", "licenseApproved", "sourcePublicationApproved"]) {
    if (policy[key] !== true) errors.push(`Approval missing: ${key}`);
  }
  if (mode === "binary" && policy.binaryPublicationApproved !== true) {
    errors.push("Approval missing: binaryPublicationApproved");
  }
  if (pkg.license !== policy.proposedLicense) errors.push("Package license is not the approved license");
  const license = path.join(root, "LICENSE");
  if (!fs.existsSync(license) || fs.statSync(license).size < 100) errors.push("LICENSE is missing or incomplete");
  if (policy.redistributionReview !== "complete") errors.push("Redistribution review is incomplete");
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = publicationErrors(root, process.argv[2] || "source");
  if (errors.length) {
    console.error("PUBLICATION BLOCKED\n" + errors.join("\n"));
    process.exitCode = 2;
  } else {
    console.log("PASS publication approvals (this does not replace signature, notarization, or runtime validation)");
  }
}
