import AppKit
import Darwin
import Foundation

private struct MenuLabels: Decodable {
    let settings: String
    let showWidget: String
    let showHover: String
    let completionNotifications: String
    let healthSettings: String
    let language: String
    let chinese: String
    let english: String
    let startup: String
    let boot: String
    let login: String
    let background: String
    let openCodex: String
    let quit: String
}

private struct MenuValues: Decodable {
    let showDesktopWidget: Bool
    let showHoverPanel: Bool
    let notifyOnUnreadCompletion: Bool
    let locale: String
    let launchAtBoot: Bool
    let launchAtLogin: Bool
    let keepInBackground: Bool
}

private struct MenuState: Decodable {
    let appName: String
    let quotaLine: String
    let taskLine: String
    let labels: MenuLabels
    let values: MenuValues
}

private struct CommandEnvelope: Encodable {
    let id: String
    let command: String
}

/// Standard AppKit host for the Electron application's menu-bar entry point.
/// It intentionally uses only NSStatusItem and documented AppKit APIs: no
/// Control Center preferences, system-process restarts, overlays, or screen
/// position guessing are needed to make the companion available.
private final class MenuBarController: NSObject, NSMenuDelegate {
    private let parentPID: pid_t
    private let statePath: String
    private let commandPath: String
    private let runtimePath: String
    private let iconPath: String
    private let commandSocketPath: String?

    private var statusItem: NSStatusItem?
    private var state: MenuState?
    private var stateModificationDate: Date?
    private var pollTimer: Timer?
    private var activationObserver: NSObjectProtocol?
    private var menu: NSMenu?
    private var placementRecoveryAttempts = 0

    init(
        parentPID: pid_t,
        statePath: String,
        commandPath: String,
        runtimePath: String,
        iconPath: String,
        commandSocketPath: String? = nil
    ) {
        self.parentPID = parentPID
        self.statePath = statePath
        self.commandPath = commandPath
        self.runtimePath = runtimePath
        self.iconPath = iconPath
        self.commandSocketPath = commandSocketPath
        super.init()

        configureStatusItem()
        _ = refreshState(force: true)
        rebuildMenu()
        writeRuntime()
        scheduleStatusItemPlacementCheck()

        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.writeRuntime()
        }

        // State writes are atomic and are also refreshed when the context menu
        // opens. This low-frequency fallback covers interrupted file events
        // without keeping an expensive polling loop alive.
        pollTimer = Timer.scheduledTimer(
            timeInterval: 10,
            target: self,
            selector: #selector(poll),
            userInfo: nil,
            repeats: true
        )
    }

    deinit {
        pollTimer?.invalidate()
        if let activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
        }
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: 28)
        item.behavior = []
        item.isVisible = false

        guard let button = item.button else {
            item.isVisible = true
            statusItem = item
            return
        }
        let image = loadTemplateImage()
        image.isTemplate = true
        image.size = NSSize(width: 22, height: 22)
        button.image = image
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyDown
        button.title = ""
        button.contentTintColor = .labelColor
        button.toolTip = "Codex Companion"
        button.target = self
        button.action = #selector(handleStatusItemClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        item.isVisible = true
        statusItem = item
    }

    private func scheduleStatusItemPlacementCheck(delay: TimeInterval = 0.6) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.recoverStatusItemPlacementIfNeeded()
        }
    }

    private func recoverStatusItemPlacementIfNeeded() {
        let frame = statusItem?.button?.window?.frame ?? .zero
        if statusItemFrameIsVisibleInMenuBar(frame) {
            writeRuntime()
            return
        }
        guard placementRecoveryAttempts < 2 else {
            writeRuntime()
            return
        }
        placementRecoveryAttempts += 1
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
        statusItem = nil
        configureStatusItem()
        scheduleStatusItemPlacementCheck()
    }

    @objc private func handleStatusItemClick(_ sender: Any?) {
        guard let event = NSApp.currentEvent else {
            writeCommand("show-panel")
            return
        }
        if event.type == .rightMouseUp || event.type == .rightMouseDown || event.buttonNumber == 1 {
            showContextMenu()
        } else {
            writeCommand("show-panel")
        }
    }

    private func showContextMenu() {
        _ = refreshState(force: true)
        rebuildMenu()
        guard let menu, let button = statusItem?.button else {
            writeCommand("show-settings")
            return
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height), in: button)
    }

    private func loadTemplateImage() -> NSImage {
        for candidate in iconCandidates() {
            guard let image = NSImage(contentsOfFile: candidate), !image.representations.isEmpty else {
                continue
            }
            image.isTemplate = true
            image.size = NSSize(width: 22, height: 22)
            return image
        }
        return Self.fallbackTemplateImage()
    }

    private func iconCandidates() -> [String] {
        let url = URL(fileURLWithPath: iconPath)
        let base = url.deletingPathExtension().path
        let retina = "\(base)@2x.\(url.pathExtension)"
        return [retina, iconPath]
    }

    private static func fallbackTemplateImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 44, height: 44))
        image.lockFocus()
        guard let context = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }
        context.saveGState()
        context.scaleBy(x: 2, y: 2)
        NSColor.black.setStroke()
        let ring = NSBezierPath()
        ring.appendArc(
            withCenter: NSPoint(x: 11, y: 11),
            radius: 7.35,
            startAngle: 48.4,
            endAngle: 361.6,
            clockwise: false
        )
        ring.lineWidth = 2.35
        ring.lineCapStyle = .butt
        ring.stroke()

        NSColor.black.setFill()
        let star = NSBezierPath()
        // A fuller, tilted four-point sparkle. At 22pt this keeps the mark
        // visibly distinct from a plus sign while remaining a clean template.
        let points: [NSPoint] = [
            NSPoint(x: 13.34, y: 16.37),
            NSPoint(x: 12.15, y: 12.18),
            NSPoint(x: 16.37, y: 10.66),
            NSPoint(x: 12.18, y: 9.85),
            NSPoint(x: 10.66, y: 5.63),
            NSPoint(x: 9.85, y: 9.82),
            NSPoint(x: 5.63, y: 11.34),
            NSPoint(x: 9.82, y: 12.15)
        ]
        for (index, point) in points.enumerated() {
            index == 0 ? star.move(to: point) : star.line(to: point)
        }
        star.close()
        star.fill()

        let sparkle = NSBezierPath()
        let sparklePoints: [NSPoint] = [
            NSPoint(x: 17.48, y: 15.45),
            NSPoint(x: 17.20, y: 14.12),
            NSPoint(x: 18.55, y: 13.85),
            NSPoint(x: 17.22, y: 13.57),
            NSPoint(x: 16.95, y: 12.22),
            NSPoint(x: 16.67, y: 13.55),
            NSPoint(x: 15.32, y: 13.83),
            NSPoint(x: 16.65, y: 14.10)
        ]
        for (index, point) in sparklePoints.enumerated() {
            index == 0 ? sparkle.move(to: point) : sparkle.line(to: point)
        }
        sparkle.close()
        sparkle.fill()
        context.restoreGState()
        image.unlockFocus()
        image.size = NSSize(width: 22, height: 22)
        image.isTemplate = true
        return image
    }

    @objc private func poll() {
        if kill(parentPID, 0) != 0 {
            NSApp.terminate(nil)
            return
        }
        if refreshState(force: false) {
            rebuildMenu()
        }
        writeRuntime()
    }

    @discardableResult
    private func refreshState(force: Bool) -> Bool {
        guard
            let attributes = try? FileManager.default.attributesOfItem(atPath: statePath),
            let modificationDate = attributes[.modificationDate] as? Date
        else {
            return false
        }
        if !force, stateModificationDate == modificationDate {
            return false
        }
        guard
            let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
            let next = try? JSONDecoder().decode(MenuState.self, from: data)
        else {
            return false
        }
        state = next
        stateModificationDate = modificationDate
        statusItem?.button?.toolTip = next.appName
        return true
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        _ = refreshState(force: true)
        rebuildMenu()
    }

    private func rebuildMenu() {
        guard let state else { return }
        let next = NSMenu(title: state.appName)
        next.delegate = self

        let title = NSMenuItem(title: state.appName, action: nil, keyEquivalent: "")
        title.isEnabled = false
        next.addItem(title)
        next.addItem(commandItem(state.quotaLine, command: "show-settings"))
        next.addItem(commandItem(state.taskLine, command: "show-settings"))
        next.addItem(.separator())
        next.addItem(commandItem(state.labels.settings, command: "show-settings"))
        next.addItem(toggleItem(
            title: state.labels.showWidget,
            value: state.values.showDesktopWidget,
            key: "showDesktopWidget"
        ))
        let hover = toggleItem(
            title: state.labels.showHover,
            value: state.values.showHoverPanel,
            key: "showHoverPanel"
        )
        hover.isEnabled = state.values.showDesktopWidget
        next.addItem(hover)
        next.addItem(toggleItem(
            title: state.labels.completionNotifications,
            value: state.values.notifyOnUnreadCompletion,
            key: "notifyOnUnreadCompletion"
        ))
        next.addItem(commandItem(state.labels.healthSettings, command: "show-settings"))
        next.addItem(.separator())

        let language = NSMenuItem(title: state.labels.language, action: nil, keyEquivalent: "")
        let languageMenu = NSMenu(title: state.labels.language)
        let chinese = commandItem(state.labels.chinese, command: "set:locale:zh-CN")
        chinese.state = state.values.locale == "zh-CN" ? .on : .off
        let english = commandItem(state.labels.english, command: "set:locale:en")
        english.state = state.values.locale == "en" ? .on : .off
        languageMenu.addItem(chinese)
        languageMenu.addItem(english)
        language.submenu = languageMenu
        next.addItem(language)

        let startup = NSMenuItem(title: state.labels.startup, action: nil, keyEquivalent: "")
        let startupMenu = NSMenu(title: state.labels.startup)
        startupMenu.addItem(toggleItem(
            title: state.labels.boot,
            value: state.values.launchAtBoot,
            key: "launchAtBoot"
        ))
        startupMenu.addItem(toggleItem(
            title: state.labels.login,
            value: state.values.launchAtLogin,
            key: "launchAtLogin"
        ))
        startupMenu.addItem(toggleItem(
            title: state.labels.background,
            value: state.values.keepInBackground,
            key: "keepInBackground"
        ))
        startup.submenu = startupMenu
        next.addItem(startup)
        next.addItem(.separator())
        next.addItem(commandItem(state.labels.openCodex, command: "open-codex"))
        next.addItem(commandItem(state.labels.quit, command: "quit"))
        menu = next
    }

    private func commandItem(_ title: String, command: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(runCommand(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = command
        return item
    }

    private func toggleItem(title: String, value: Bool, key: String) -> NSMenuItem {
        let command = "set:\(key):\(!value)"
        let item = commandItem(title, command: command)
        item.state = value ? .on : .off
        return item
    }

    @objc private func runCommand(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? String else { return }
        writeCommand(command)
    }

    private func writeCommand(_ command: String) {
        let envelope = CommandEnvelope(id: UUID().uuidString, command: command)
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        if sendCommandThroughSocket(data) {
            return
        }
        let destination = URL(fileURLWithPath: commandPath)
        let directory = destination.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let temporary = directory.appendingPathComponent(".menu-command-\(UUID().uuidString).json")
        do {
            try data.write(to: temporary, options: .atomic)
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } catch {
            try? data.write(to: destination, options: .atomic)
            try? FileManager.default.removeItem(at: temporary)
        }
    }

    private func sendCommandThroughSocket(_ data: Data) -> Bool {
        guard
            let commandSocketPath,
            !commandSocketPath.isEmpty,
            let pathData = commandSocketPath.data(using: .utf8)
        else {
            return false
        }
        var address = sockaddr_un()
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathData.count + 1 <= pathCapacity else {
            return false
        }
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.initializeMemory(as: UInt8.self, repeating: 0)
            pathData.withUnsafeBytes { source in
                destination.copyBytes(from: source)
            }
        }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        let length = socklen_t(MemoryLayout<sa_family_t>.size + pathData.count + 1)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, length)
            }
        }
        guard connected == 0 else { return false }
        var payload = data
        payload.append(0x0A)
        return payload.withUnsafeBytes { buffer in
            guard let baseAddress = buffer.baseAddress else { return false }
            var sent = 0
            while sent < buffer.count {
                let result = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: sent),
                    buffer.count - sent
                )
                if result <= 0 { return false }
                sent += result
            }
            return true
        }
    }

    private func writeRuntime() {
        let button = statusItem?.button
        let window = button?.window
        let frame = window?.frame ?? .zero
        let frameIsVisibleInMenuBar = statusItemFrameIsVisibleInMenuBar(frame)
        let payload: [String: Any] = [
            "menuBarImplementation": "ns-status-item",
            "pid": ProcessInfo.processInfo.processIdentifier,
            "parentPID": parentPID,
            "statusItemBundleIdentifier": Bundle.main.bundleIdentifier ?? "",
            "statusItemPersistenceMode": "bundle-default",
            "statusItemAutosaveName": statusItem?.autosaveName ?? "",
            "statusItemVisiblePreference": statusItem?.isVisible ?? false,
            "statusItemButtonHidden": button?.isHidden ?? true,
            "statusItemWindowVisible": window?.isVisible ?? false,
            "statusItemWindowHosted": window != nil,
            "statusItemWindowOnScreen": window?.screen != nil,
            "statusItemWindowFrameVisible": frameIsVisibleInMenuBar,
            "statusItemWindowNumber": window?.windowNumber ?? 0,
            "statusItemWindowFrame": [
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.size.width,
                "height": frame.size.height
            ],
            "statusItemImageEmpty": button?.image?.representations.isEmpty ?? true,
            "statusItemImageTemplate": button?.image?.isTemplate ?? false,
            "frontmostBundleIdentifier": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
            "frontmostApplicationName": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
            "updatedAt": Date().timeIntervalSince1970 * 1_000
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: URL(fileURLWithPath: runtimePath), options: .atomic)
    }

    private func statusItemFrameIsVisibleInMenuBar(_ frame: NSRect) -> Bool {
        guard frame.width > 0, frame.height > 0 else { return false }
        return NSScreen.screens.contains { screen in
            let screenFrame = screen.frame
            let menuBarBoundary = screen.visibleFrame.maxY
            return frame.intersects(screenFrame)
                && frame.midY >= menuBarBoundary
                && frame.maxY <= screenFrame.maxY + 2
        }
    }
}

@main
private struct CodexCompanionMenuBarApp {
    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count >= 6, let parentPID = pid_t(arguments[1]) else {
            fputs("Usage: Codex Companion Menu Bar <parent-pid> <state-path> <command-path> <runtime-path> <icon-path> [command-socket-path]\\n", stderr)
            exit(64)
        }

        let lockPath = "\(arguments[4]).lock"
        let lockDescriptor = Darwin.open(
            lockPath,
            O_CREAT | O_RDWR,
            S_IRUSR | S_IWUSR
        )
        guard lockDescriptor >= 0 else { exit(73) }
        guard Darwin.lockf(lockDescriptor, F_TLOCK, 0) == 0 else {
            Darwin.close(lockDescriptor)
            exit(0)
        }
        defer {
            _ = Darwin.lockf(lockDescriptor, F_ULOCK, 0)
            Darwin.close(lockDescriptor)
        }

        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = MenuBarController(
            parentPID: parentPID,
            statePath: arguments[2],
            commandPath: arguments[3],
            runtimePath: arguments[4],
            iconPath: arguments[5],
            commandSocketPath: arguments.count >= 7 ? arguments[6] : nil
        )
        withExtendedLifetime(controller) {
            application.run()
        }
    }
}
