import AppKit
import CoreGraphics
import Foundation
import Darwin

// Test-owned accessory apps only. Stdin/stdout commands let the Electron
// test exercise real NSWorkspace activation and macOS window ordering without
// controlling Codex, sending real messages, or requesting screen recording.
private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
}

private final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var overlay: NSPanel?
    private var parentSource: DispatchSourceProcess?
    private var buffer = Data()

    func applicationDidFinishLaunching(_ note: Notification) {
        signal(SIGPIPE, SIG_IGN)
        guard let pid = CommandLine.arguments.dropFirst().first.flatMap(Int32.init),
              pid > 1, kill(pid, 0) == 0 else { exit(EXIT_FAILURE) }
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { exit(EXIT_SUCCESS) }
        parentSource = source
        source.resume()
        FileHandle.standardInput.readabilityHandler = { [weak self] input in
            let data = input.availableData
            DispatchQueue.main.async {
                guard !data.isEmpty else { NSApplication.shared.terminate(nil); return }
                self?.receive(data)
            }
        }
        emit(["event": "ready", "pid": ProcessInfo.processInfo.processIdentifier,
              "bundleIdentifier": Bundle.main.bundleIdentifier ?? ""])
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline)
            buffer.removeSubrange(...newline)
            guard let command = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            handle(command)
        }
    }

    private func handle(_ command: [String: Any]) {
        var reply: [String: Any] = ["id": command["id"] ?? 0]
        switch command["type"] as? String {
        case "activate":
            if window == nil {
                window = NSWindow(contentRect: NSRect(x: 80, y: 100, width: 260, height: 90),
                    styleMask: [.titled], backing: .buffered, defer: false)
                window?.title = "通知前台切换测试（自动关闭）"
            }
            window?.makeKeyAndOrderFront(nil)
            reply["activated"] = NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps])
        case "peer":
            let bounds = command["bounds"] as? [String: Double] ?? [:]
            let top = NSScreen.screens.first?.frame.maxY ?? 900
            let frame = NSRect(x: bounds["x"] ?? 900,
                y: top - (bounds["y"] ?? 40) - (bounds["height"] ?? 144),
                width: bounds["width"] ?? 440, height: bounds["height"] ?? 144)
            if overlay == nil {
                overlay = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                    backing: .buffered, defer: false)
                overlay?.backgroundColor = .windowBackgroundColor
                let label = NSTextField(labelWithString: "较晚出现的测试提醒（自动关闭）")
                label.frame = NSRect(x: 20, y: 30, width: 390, height: 40)
                overlay?.contentView?.addSubview(label)
            }
            overlay?.setFrame(frame, display: true)
            overlay?.level = command["level"] as? String == "floating" ? .floating : .popUpMenu
            overlay?.orderFrontRegardless()
        case "order":
            let pids = Set(command["pids"] as? [Int] ?? [])
            let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] ?? []
            // Never return other applications' titles, window contents or IDs.
            reply["windows"] = all.compactMap { item -> [String: Any]? in
                guard let pid = item[kCGWindowOwnerPID as String] as? Int, pids.contains(pid) else { return nil }
                return ["pid": pid, "layer": item[kCGWindowLayer as String] ?? -1,
                    "bounds": item[kCGWindowBounds as String] ?? [:]]
            }
        case "restore":
            if let id = command["bundleIdentifier"] as? String, id != "com.apple.loginwindow" {
                _ = NSRunningApplication.runningApplications(withBundleIdentifier: id).first?
                    .activate(options: [.activateIgnoringOtherApps])
            }
        default:
            reply["error"] = "Unknown test command"
        }
        emit(reply)
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
private let fixture = Fixture()
application.delegate = fixture
application.run()
