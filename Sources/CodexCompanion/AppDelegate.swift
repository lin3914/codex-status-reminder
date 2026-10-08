import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = CompanionStore()
    private var windowController: CompanionWindowController?
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let duplicates = NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.lindaozhi.codexstatusreminder"
        ).filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        guard duplicates.isEmpty else {
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(.accessory)
        windowController = CompanionWindowController(store: store)
        windowController?.show()
        store.start()
        installStatusItem()
    }

    func applicationWillTerminate(_ notification: Notification) {
        store.stop()
        windowController?.close()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "circle.circle.fill", accessibilityDescription: "Codex Companion")
        item.button?.imagePosition = .imageOnly
        let menu = NSMenu()
        menu.addItem(
            withTitle: "立即刷新",
            action: #selector(refreshNow),
            keyEquivalent: "r"
        )
        menu.addItem(
            withTitle: "打开 Codex",
            action: #selector(openCodex),
            keyEquivalent: ""
        )
        menu.addItem(.separator())
        menu.addItem(
            withTitle: "退出 Codex Companion",
            action: #selector(quit),
            keyEquivalent: "q"
        )
        for item in menu.items {
            item.target = self
        }
        item.menu = menu
        statusItem = item
    }

    @objc private func refreshNow() {
        Task { await store.refresh() }
    }

    @objc private func openCodex() {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") else {
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
