#!/usr/bin/env node

import process from "node:process";
import { signAsync } from "@electron/osx-sign";

const appPath = process.argv[2];
const identity = process.env.CODEX_COMPANION_SIGN_IDENTITY;

if (!appPath || !identity) {
  console.error(
    "Usage: CODEX_COMPANION_SIGN_IDENTITY='Developer ID Application: …' "
      + "node scripts/sign-macos-app.mjs '/path/to/Codex Companion.app'"
  );
  process.exit(2);
}

await signAsync({
  app: appPath,
  identity,
  ...(process.env.CODEX_COMPANION_KEYCHAIN
    ? { keychain: process.env.CODEX_COMPANION_KEYCHAIN }
    : {}),
  platform: "darwin",
  type: "distribution",
  hardenedRuntime: true,
  gatekeeperAssess: false
});
