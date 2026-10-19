# CodeX Status Reminder

A third-party macOS companion for Codex. See weekly quota, reset time and recent tasks in the menu bar or an optional desktop widget. Completion cards appear while Codex is in the background; opening Codex dismisses all alerts without changing unread status. Individual cards can also be opened or dismissed.

This app is independent of OpenAI and is not an official OpenAI product. End users do not need to install Electron or Node.js separately.

The project is licensed under [Apache-2.0](LICENSE). The maintainer has confirmed the rights to publish the code and icons. Current download: **1.9.15 (66), Apple Silicon public trial**. It is ad-hoc signed, not Developer ID-signed or Apple-notarized. macOS may block the first launch; do not disable system security.

When unread receipts are unavailable, tasks show a syncing state and the count is unknown, never assumed to be viewed. Compatibility with individual real Codex versions still needs validation; see [compatibility](docs/COMPATIBILITY.md).

## Download and install

[Download 1.9.15 DMG (recommended)](https://github.com/lin3914/codex-status-reminder/releases/download/v1.9.15/CodeX-Status-Reminder-1.9.15-66-trial-macos-arm64.dmg) · [ZIP](https://github.com/lin3914/codex-status-reminder/releases/download/v1.9.15/CodeX-Status-Reminder-1.9.15-66-trial-macos-arm64.zip) · [Release notes and checksums](https://github.com/lin3914/codex-status-reminder/releases/tag/v1.9.15) · [Latest release](https://github.com/lin3914/codex-status-reminder/releases/latest)

M-series Macs only; no Intel binary is published. These are the original files used for the local installation and notification checks, not newly rebuilt replacements. See the [version manifest](docs/releases/v1.9.15.json).

Install and sign in to Codex first. Open the DMG and drag the app to Applications, then launch it there. For upgrades, quit the old app and replace it without deleting its configuration. If you trust the source and verify the checksum, follow [Apple's instructions](https://support.apple.com/en-us/102445) to allow this particular unnotarized app. Managed devices may prevent that. Do not remove quarantine or bypass malware/damage warnings.

## Interaction

- Left-click the menu-bar item to toggle the complete task panel.
- Right-click for settings. Hover does not open the panel.
- The optional desktop widget expands on hover, can be dragged, and stays above ordinary windows. It is hidden in full-screen apps.
- Green means stopped and unread, pale yellow means active, gray means stopped and viewed.
- Completion cards persist without a timeout, but opening or switching back to Codex dismisses the entire group. Switching away does not restore those old alerts. Clicking a card opens its conversation; the close button dismisses only that card. Dismissal does not mark any Codex conversation as read. Later background completions can still notify.
- Cards use the standard floating window level. Newer notifications from other apps can appear above them, and background refreshes do not repeatedly raise our cards.
- Quota health compares quota consumption with elapsed time. The default healthy lead is 12 hours; the default alert line is 24 hours. Both can be adjusted through the linked/custom modes.

## Build

Use macOS, Node.js 22, Xcode Command Line Tools with Swift 6+, and ripgrep.

```sh
npm ci
npm test
npm run audit:public
npm run build
npm run check:release
```

Output: `.build/products/CodeX状态提醒.app`. The development build uses ad-hoc signing and is not a notarized public distribution.

The bundle keeps its existing macOS 12.0 minimum declaration. Actual cross-machine, macOS 12/13 and Intel acceptance remains to be completed; a declaration or successful cross-build is not a real-device test. Quota uses the official Codex app-server protocol first, with the current read-only compatibility fallback. Task/unread desktop integration is version-sensitive.

[User guide (Chinese)](docs/USER_GUIDE.md) · [Compatibility](docs/COMPATIBILITY.md) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
