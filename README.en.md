# CodeX Status Reminder

A third-party macOS companion for Codex. See weekly quota, reset time and recent tasks in the menu bar or an optional desktop widget. Persistent completion cards can be opened or dismissed individually.

This app is independent of OpenAI and is not an official OpenAI product. End users do not need to install Electron or Node.js separately.

The project is licensed under [Apache-2.0](LICENSE). The maintainer has confirmed the rights to publish the code and icons. Source version: 1.9.14 (65). No Developer ID-signed, notarized public download has been released; local ad-hoc development builds are not an end-user release.

Known release blocker: if the task index loads but unread-state reading fails, stopped tasks can be incorrectly shown as viewed. This must be corrected and validated before an end-user binary release; see [compatibility](docs/COMPATIBILITY.md).

## Interaction

- Left-click the menu-bar item to toggle the complete task panel.
- Right-click for settings. Hover does not open the panel.
- The optional desktop widget expands on hover, can be dragged, and stays above ordinary windows. It is hidden in full-screen apps.
- Green means stopped and unread, pale yellow means active, gray means stopped and viewed.
- A completion card persists without a timeout. Clicking it removes that card immediately and asks Codex to open the conversation; viewing the conversation directly in Codex removes it after read-state sync. A close button also dismisses the card without marking the conversation as read. A failed deep link does not restore the card.
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
