import Foundation

enum CodexAppServerError: LocalizedError {
    case binaryUnavailable
    case notConnected
    case timeout(String)
    case server(String)

    var errorDescription: String? {
        switch self {
        case .binaryUnavailable: "找不到 Codex app-server"
        case .notConnected: "Codex app-server 尚未连接"
        case .timeout(let method): "\(method) 请求超时"
        case .server(let message): message
        }
    }
}

struct AppServerDataSnapshot {
    let quota: QuotaSnapshot
}

actor CodexAppServerClient {
    private let executableURL: URL
    private var process: Process?
    private var inputHandle: FileHandle?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var timeoutTasks: [Int: Task<Void, Never>] = [:]
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var stdoutBuffer = Data()
    private var isInitialized = false

    init(executableURL: URL = CodexAppServerClient.resolveExecutable()) {
        self.executableURL = executableURL
    }

    deinit {
        outputHandle?.readabilityHandler = nil
        errorHandle?.readabilityHandler = nil
        process?.terminate()
    }

    func fetchSnapshot() async throws -> AppServerDataSnapshot {
        try await ensureStarted()
        let quotaJSON = try await request(method: "account/rateLimits/read", params: nil)
        return AppServerDataSnapshot(
            quota: Self.parseQuota(quotaJSON)
        )
    }

    func stop() {
        isInitialized = false
        inputHandle = nil
        outputHandle?.readabilityHandler = nil
        outputHandle = nil
        errorHandle?.readabilityHandler = nil
        errorHandle = nil
        if process?.isRunning == true {
            process?.terminate()
        }
        process = nil
        let waiters = pending
        pending.removeAll()
        for (_, continuation) in waiters {
            continuation.resume(throwing: CodexAppServerError.notConnected)
        }
        timeoutTasks.values.forEach { $0.cancel() }
        timeoutTasks.removeAll()
    }

    private func ensureStarted() async throws {
        if isInitialized, process?.isRunning == true {
            return
        }

        stop()
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw CodexAppServerError.binaryUnavailable
        }

        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = Pipe()
        let process = Process()
        process.executableURL = executableURL
        process.arguments = ["app-server", "--listen", "stdio://"]
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        process.environment = environment
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        process.terminationHandler = { [weak self] _ in
            guard let client = self else { return }
            Task { await client.handleProcessExit() }
        }

        try process.run()
        self.process = process
        inputHandle = stdin.fileHandleForWriting

        let outputHandle = stdout.fileHandleForReading
        self.outputHandle = outputHandle
        outputHandle.readabilityHandler = { [weak self] handle in
            guard let client = self else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                Task { await client.handleProcessExit() }
            } else {
                Task { await client.ingest(data: data) }
            }
        }
        let errorHandle = stderr.fileHandleForReading
        self.errorHandle = errorHandle
        errorHandle.readabilityHandler = { handle in
            if handle.availableData.isEmpty {
                handle.readabilityHandler = nil
            }
        }

        _ = try await request(
            method: "initialize",
            params: [
                "clientInfo": [
                    "name": "codex_companion",
                    "title": "Codex Companion",
                    "version": CompanionVersion.current,
                ],
                "capabilities": NSNull(),
            ]
        )
        try sendNotification(method: "initialized", params: [:])
        isInitialized = true
    }

    private func request(method: String, params: [String: Any]?) async throws -> [String: Any] {
        guard let inputHandle, process?.isRunning == true else {
            throw CodexAppServerError.notConnected
        }

        let id = nextID
        nextID += 1
        var body: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        ]
        if let params {
            body["params"] = params
        }

        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            timeoutTasks[id] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                await self?.timeout(id: id, method: method)
            }

            do {
                var payload = try JSONSerialization.data(withJSONObject: body)
                payload.append(0x0A)
                try inputHandle.write(contentsOf: payload)
            } catch {
                pending.removeValue(forKey: id)
                timeoutTasks.removeValue(forKey: id)?.cancel()
                continuation.resume(throwing: error)
            }
        }
    }

    private func sendNotification(method: String, params: [String: Any]) throws {
        guard let inputHandle else { throw CodexAppServerError.notConnected }
        let body: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        ]
        var payload = try JSONSerialization.data(withJSONObject: body)
        payload.append(0x0A)
        try inputHandle.write(contentsOf: payload)
    }

    private func ingest(data: Data) {
        stdoutBuffer.append(data)
        while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
            let line = Data(stdoutBuffer[..<newline])
            stdoutBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            dispatch(line: line)
        }
    }

    private func dispatch(line: Data) {
        guard
            let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let id = message["id"] as? Int,
            let continuation = pending.removeValue(forKey: id)
        else {
            return
        }

        timeoutTasks.removeValue(forKey: id)?.cancel()
        if let error = message["error"] as? [String: Any] {
            continuation.resume(
                throwing: CodexAppServerError.server(
                    error["message"] as? String ?? "Codex app-server 请求失败"
                )
            )
            return
        }
        continuation.resume(returning: message["result"] as? [String: Any] ?? [:])
    }

    private func timeout(id: Int, method: String) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        timeoutTasks.removeValue(forKey: id)
        continuation.resume(throwing: CodexAppServerError.timeout(method))
    }

    private func handleProcessExit() {
        guard process != nil else { return }
        stop()
    }

    static func resolveExecutable() -> URL {
        let environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let relativePaths = [
            "Contents/Resources/codex-cli/bin/codex",
            "Contents/Resources/codex",
            "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
        ]
        var candidates = [environment["CODEX_COMPANION_CODEX_BINARY"]].compactMap { $0 }
            .filter { $0.hasPrefix("/") }
        for root in ["/Applications", home + "/Applications"] {
            for name in ["Codex.app", "ChatGPT.app"] {
                candidates += relativePaths.map { root + "/" + name + "/" + $0 }
            }
        }
        candidates += (environment["PATH"] ?? "").split(separator: ":")
            .filter { $0.hasPrefix("/") }.map { String($0) + "/codex" }
        candidates += ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", home + "/.local/bin/codex"]
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }
        return URL(fileURLWithPath: "/usr/local/bin/codex")
    }

    private static func parseQuota(_ result: [String: Any]) -> QuotaSnapshot {
        guard let limits = result["rateLimits"] as? [String: Any] else {
            return QuotaSnapshot()
        }

        let windows = ["primary", "secondary"]
            .compactMap { limits[$0] as? [String: Any] }
        guard
            let weekly = windows
                .filter({ number($0["windowDurationMins"]) ?? 0 > 720 })
                .max(by: {
                    (number($0["windowDurationMins"]) ?? 0)
                        < (number($1["windowDurationMins"]) ?? 0)
                }),
            let usedPercent = number(weekly["usedPercent"]),
            let windowMinutes = number(weekly["windowDurationMins"])
        else {
            return QuotaSnapshot()
        }

        let resetTimestamp = number(weekly["resetsAt"])
        let resetAt = resetTimestamp.map(Self.dateFromEpoch)
        let timeRemainingPercent: Double?
        if let resetAt {
            let remainingMinutes = max(0, resetAt.timeIntervalSinceNow / 60)
            timeRemainingPercent = (remainingMinutes / max(1, windowMinutes) * 100).clampedPercent
        } else {
            timeRemainingPercent = nil
        }

        return QuotaSnapshot(
            isAvailable: true,
            usedPercent: usedPercent.clampedPercent,
            remainingPercent: (100 - usedPercent).clampedPercent,
            timeRemainingPercent: timeRemainingPercent,
            resetAt: resetAt,
            windowMinutes: windowMinutes,
            source: "app-server"
        )
    }

    private static func dateFromEpoch(_ value: Double) -> Date {
        Date(timeIntervalSince1970: value > 1_000_000_000_000 ? value / 1000 : value)
    }

    private static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}
