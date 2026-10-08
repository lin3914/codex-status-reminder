import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { publicationErrors } from "../../scripts/check-publication.mjs";
import { validateBuildPath } from "../../scripts/validate-build-paths.mjs";
import { auditPublicSource } from "../../scripts/audit-public-source.mjs";
import { electronSupport } from "../../scripts/check-electron-support.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-fixture-"));
try {
  const releases = [{version:"44.1.0"},{version:"43.7.9"},{version:"42.3.0"},{version:"41.9.0"},{version:"46.0.0-beta.1"}];
  assert.deepEqual(electronSupport(releases, "43.4.1").supportedMajors, [44,43,42]);
  assert.equal(electronSupport(releases, "43.4.1").currentPatch, false);
  assert.equal(electronSupport(releases, "43.7.9").currentPatch, true);
  assert.equal(electronSupport(releases, "41.9.0").supported, false);
  assert.deepEqual(publicationErrors(root, "source"), [], "approved source must pass the publication gate");
  assert(publicationErrors(root, "binary").some(x => x.includes("binaryPublicationApproved")),
    "source approval must not silently authorize a public binary release");
  const policy = {
    proposedLicense: "Apache-2.0", rightsConfirmed: true, licenseApproved: true,
    sourcePublicationApproved: true, binaryPublicationApproved: false,
    redistributionReview: "complete"
  };
  fs.writeFileSync(path.join(temp, "publication-policy.json"), JSON.stringify(policy));
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ license: "Apache-2.0" }));
  fs.writeFileSync(path.join(temp, "LICENSE"), "Apache License fixture ".repeat(20));
  assert.deepEqual(publicationErrors(temp, "source"), []);
  assert(publicationErrors(temp, "binary").some(x => x.includes("binaryPublicationApproved")));
  fs.rmSync(path.join(temp, "LICENSE"));
  assert(publicationErrors(temp, "source").some(x => x.includes("LICENSE")));
  assert(publicationErrors(temp, "unknown").length);
  assert.equal(validateBuildPath(temp, path.join(temp, ".build", "app.app")), path.join(temp, ".build", "app.app"));
  for (const target of ["/", os.homedir(), temp, path.join(temp, ".build"), "/Applications/CodeX状态提醒.app"]) {
    assert.throws(() => validateBuildPath(temp, target));
  }
  fs.symlinkSync(os.tmpdir(), path.join(temp, ".build"));
  assert.throws(() => validateBuildPath(temp, path.join(temp, ".build", "escape")));
  fs.unlinkSync(path.join(temp, ".build"));
  const auditDir = fs.mkdtempSync(path.join(temp, "audit-"));
  fs.writeFileSync(path.join(auditDir, "auth.json"), "{}");
  assert(auditPublicSource(auditDir).findings.some(x => x.includes("sensitive file")));
  const release = fs.readFileSync(path.join(root, ".github/workflows/release-macos.yml"), "utf8");
  assert.match(release, /environment: release/);
  assert.match(release, /--draft --prerelease/);
  assert.doesNotMatch(release, /--clobber|pull_request_target/);
  assert.match(release, /CODEX_COMPANION_KEYCHAIN: \$\{\{ runner\.temp \}\}\/codex-release\.keychain-db/);
  for (const script of ["sign-macos-app.mjs", "notarize-macos-app.mjs"]) {
    assert.match(fs.readFileSync(path.join(root, "scripts", script), "utf8"),
      /keychain: process\.env\.CODEX_COMPANION_KEYCHAIN/,
      "signing and notarization must use the temporary credential keychain");
  }
  const uses = [...release.matchAll(/uses: ([^\s]+)/g)].map(m => m[1]);
  assert(uses.every(value => /@[a-f0-9]{40}$/.test(value)), "Actions must be pinned to reviewed commits");
  assert.match(fs.readFileSync(path.join(root, "Tests/SelfTest/SelfTest.swift"), "utf8"), /CODEX_COMPANION_LIVE_TESTS/);
  const installer = spawnSync("/bin/zsh", [path.join(root, "scripts/install-app.sh")], {
    env: { ...process.env, CODEX_COMPANION_ALLOW_DEVELOPMENT_INSTALL: "0" }, encoding: "utf8"
  });
  assert.equal(installer.status, 2, "historical migration installer must fail closed by default");
  assert.match(installer.stderr, /disabled by default/);
  console.log("PASS public-release: approvals, safe outputs, privacy audit, CI contracts, no-Codex default");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
