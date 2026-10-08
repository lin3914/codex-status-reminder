import AppKit
import Darwin
import Dispatch
import Foundation

private let crashWindow: TimeInterval = 90
private let maximumUnexpectedExitRestarts = 2

private struct RecoveryCrashState: Codable {
    var unexpectedExitTimes: [TimeInterval]
}

/// A small, ordinary child process used only while the user has enabled
/// “keep running in background”. It monitors the main app process with a
/// public Dispatch process source. A normal Quit leaves a marker and exits;
/// an unexpected main-process exit reopens the same .app bundle.
private final class RecoveryController {
    private let parentPID: pid_t
    private let appURL: URL
    private let gracefulMarkerURL: URL
    private let crashStateURL: URL
    private let token: String
    private var processSource: DispatchSourceProcess?

    init?(arguments: [String]) {
        guard
            arguments.count == 6,
            let pid = Int32(arguments[1]),
            pid > 0,
            arguments[2].hasSuffix(".app")
        else {
            return nil
        }
        parentPID = pid_t(pid)
        appURL = URL(fileURLWithPath: arguments[2])
        gracefulMarkerURL = URL(fileURLWithPath: arguments[3])
        crashStateURL = URL(fileURLWithPath: arguments[4])
        token = arguments[5]
    }

    func start() {
        if kill(parentPID, 0) != 0 {
            handleParentExit()
            return
        }
        let source = DispatchSource.makeProcessSource(
            identifier: parentPID,
            eventMask: .exit,
            queue: .main
        )
        source.setEventHandler { [weak self] in
            self?.handleParentExit()
        }
        processSource = source
        source.resume()
    }

    private func handleParentExit() {
        processSource?.cancel()
        processSource = nil
        guard !didExitGracefully() else {
            terminate(success: true)
            return
        }
        // A deterministic startup fault should not be amplified into an
        // endless reopen/crash loop. The parent app clears this state after
        // it has stayed alive for a short stability window.
        guard shouldAttemptRecovery() else {
            terminate(success: true)
            return
        }
        // Let Electron release its single-instance lock before asking the
        // standard workspace service to reopen the same bundle.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [self] in
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.addsToRecentItems = false
            NSWorkspace.shared.openApplication(
                at: appURL,
                configuration: configuration
            ) { _, error in
                self.terminate(success: error == nil)
            }
        }
    }

    private func didExitGracefully() -> Bool {
        guard let value = try? String(contentsOf: gracefulMarkerURL, encoding: .utf8) else {
            return false
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines) == token
    }

    private func shouldAttemptRecovery() -> Bool {
        let now = Date().timeIntervalSince1970
        let cutoff = now - crashWindow
        let previous: RecoveryCrashState
        if let data = try? Data(contentsOf: crashStateURL),
           let decoded = try? JSONDecoder().decode(RecoveryCrashState.self, from: data) {
            previous = decoded
        } else {
            previous = RecoveryCrashState(unexpectedExitTimes: [])
        }
        let attempts = previous.unexpectedExitTimes.filter { $0 >= cutoff } + [now]
        let next = RecoveryCrashState(unexpectedExitTimes: attempts)
        do {
            try FileManager.default.createDirectory(
                at: crashStateURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(next)
            try data.write(to: crashStateURL, options: .atomic)
        } catch {
            // A recovery loop is worse than losing one automatic reopen.
            // If the app-owned state cannot be persisted, fail closed.
            return false
        }
        return attempts.count <= maximumUnexpectedExitRestarts
    }

    private func terminate(success: Bool) {
        exit(success ? EXIT_SUCCESS : EXIT_FAILURE)
    }
}

// A separate, read-only command mode. Do not start recovery, activate this
// process or touch application/system preferences when querying the foreground.
if CommandLine.arguments.count == 2,
   CommandLine.arguments[1] == "--frontmost-bundle-id" {
    guard let identifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
          !identifier.isEmpty else {
        exit(EXIT_FAILURE)
    }
    print(identifier)
    exit(EXIT_SUCCESS)
}

guard let controller = RecoveryController(arguments: CommandLine.arguments) else {
    exit(EXIT_FAILURE)
}
controller.start()
RunLoop.main.run()
