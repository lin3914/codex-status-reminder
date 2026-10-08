#!/usr/bin/env node

import process from "node:process";
import { notarize } from "@electron/notarize";

const appPath = process.argv[2];
const keychainProfile = process.env.CODEX_COMPANION_NOTARY_PROFILE;

if (!appPath || !keychainProfile) {
  console.error(
    "Usage: CODEX_COMPANION_NOTARY_PROFILE=profile "
      + "node scripts/notarize-macos-app.mjs '/path/to/Codex Companion.app'"
  );
  process.exit(2);
}

await notarize({
  appPath,
  keychainProfile,
  ...(process.env.CODEX_COMPANION_KEYCHAIN
    ? { keychain: process.env.CODEX_COMPANION_KEYCHAIN }
    : {})
});
