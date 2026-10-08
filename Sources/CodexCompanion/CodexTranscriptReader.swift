import Foundation

private struct ThreadIndexRow {
    let id: String
    let rolloutPath: URL
    let title: String
    let preview: String
    let updatedAt: Date
    let recencyAt: Date
    let cwd: String
}

struct TranscriptObservation {
    let latestProgress: String
    let latestProgressAt: Date
    let latestTaskStartedAt: Date?
    let latestTaskCompletedAt: Date?

    var isRunning: Bool {
        guard let latestTaskStartedAt else { return false }
        guard let latestTaskCompletedAt else { return true }
        return latestTaskStartedAt > latestTaskCompletedAt
    }
}

struct CodexTranscriptReader {
    let stateDatabaseURL: URL

    init(
        stateDatabaseURL: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/state_5.sqlite")
    ) {
        self.stateDatabaseURL = stateDatabaseURL
    }

    func readTasks(
        unreadState: CodexUnreadState
    ) -> [CompanionTask] {
        let indexRows = readThreadIndex(limit: 120)

        return indexRows.compactMap { row -> CompanionTask? in
            let observation = readObservation(from: row.rolloutPath)
            let isUnread = unreadState.isAvailable && unreadState.threadIDs.contains(row.id)
            let state: CompanionTaskState
            if observation.isRunning {
                state = .running
            } else if isUnread {
                state = .unread
            } else {
                state = .completed
            }

            let title = firstNonEmpty(
                row.title,
                row.preview,
                "Codex 会话"
            )
            let progress = observation.latestProgress.isEmpty
                ? (state == .running ? "任务执行中，等待最新进展" : "任务已完成")
                : observation.latestProgress
            let activityAt = max(
                observation.latestProgressAt,
                row.recencyAt,
                row.updatedAt
            )
            return CompanionTask(
                id: row.id,
                title: cleanDisplayText(title),
                latestProgress: cleanDisplayText(progress),
                state: state,
                activityAt: activityAt,
                rolloutPath: row.rolloutPath,
                cwd: row.cwd
            )
        }
    }

    func readObservation(from url: URL, maxBytes: Int = 1_500_000) -> TranscriptObservation {
        guard
            let handle = try? FileHandle(forReadingFrom: url),
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
            let sizeNumber = attributes[.size] as? NSNumber
        else {
            return TranscriptObservation(
                latestProgress: "",
                latestProgressAt: .distantPast,
                latestTaskStartedAt: nil,
                latestTaskCompletedAt: nil
            )
        }
        defer { try? handle.close() }

        let size = sizeNumber.intValue
        let start = max(0, size - maxBytes)
        try? handle.seek(toOffset: UInt64(start))
        guard var data = try? handle.readToEnd(), !data.isEmpty else {
            return TranscriptObservation(
                latestProgress: "",
                latestProgressAt: .distantPast,
                latestTaskStartedAt: nil,
                latestTaskCompletedAt: nil
            )
        }
        if start > 0, let newline = data.firstIndex(of: 0x0A) {
            data = Data(data[data.index(after: newline)...])
        }

        var latestProgress = ""
        var latestProgressAt = Date.distantPast
        var latestTaskStartedAt: Date?
        var latestTaskCompletedAt: Date?

        for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
            guard
                let root = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                let timestamp = parseDate(root["timestamp"])
            else {
                continue
            }

            let type = root["type"] as? String
            let payload = root["payload"] as? [String: Any]
            let payloadType = payload?["type"] as? String

            if type == "event_msg" {
                if payloadType == "task_started" {
                    latestTaskStartedAt = max(latestTaskStartedAt ?? .distantPast, timestamp)
                } else if payloadType == "task_complete" {
                    latestTaskCompletedAt = max(latestTaskCompletedAt ?? .distantPast, timestamp)
                    if
                        let message = payload?["last_agent_message"] as? String,
                        !message.isEmpty,
                        timestamp >= latestProgressAt
                    {
                        latestProgress = message
                        latestProgressAt = timestamp
                    }
                } else if payloadType == "agent_message",
                          let message = payload?["message"] as? String,
                          !message.isEmpty,
                          timestamp >= latestProgressAt
                {
                    latestProgress = message
                    latestProgressAt = timestamp
                } else if payloadType == "agent_reasoning",
                          let text = payload?["text"] as? String,
                          !text.isEmpty,
                          timestamp >= latestProgressAt
                {
                    latestProgress = text
                    latestProgressAt = timestamp
                }
                continue
            }

            if type == "response_item", payloadType == "message" {
                guard
                    let role = payload?["role"] as? String,
                    role == "assistant",
                    let content = payload?["content"] as? [[String: Any]]
                else {
                    continue
                }
                let text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
                if !text.isEmpty, timestamp >= latestProgressAt {
                    latestProgress = text
                    latestProgressAt = timestamp
                }
            }
        }

        return TranscriptObservation(
            latestProgress: latestProgress,
            latestProgressAt: latestProgressAt,
            latestTaskStartedAt: latestTaskStartedAt,
            latestTaskCompletedAt: latestTaskCompletedAt
        )
    }

    private func readThreadIndex(limit: Int) -> [ThreadIndexRow] {
        guard FileManager.default.fileExists(atPath: stateDatabaseURL.path) else { return [] }
        let sql = """
        SELECT id,
               rollout_path,
               COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(preview, ''), 'Codex 会话'),
               COALESCE(preview, ''),
               COALESCE(updated_at_ms, updated_at * 1000),
               COALESCE(NULLIF(recency_at_ms, 0), updated_at_ms, updated_at * 1000),
               COALESCE(cwd, '')
          FROM threads
         WHERE archived = 0
           AND preview <> ''
           AND lower(COALESCE(thread_source, '')) NOT LIKE 'subagent%'
           AND lower(COALESCE(source, '')) NOT LIKE '%"subagent"%'
         ORDER BY COALESCE(NULLIF(recency_at_ms, 0), updated_at_ms, updated_at * 1000) DESC
         LIMIT \(max(10, limit));
        """

        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = ["-separator", "\u{1F}", stateDatabaseURL.path, sql]
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return []
        }
        guard
            let data = try? output.fileHandleForReading.readToEnd(),
            let text = String(data: data, encoding: .utf8)
        else {
            return []
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return [] }

        return text.split(separator: "\n").compactMap { line in
            let fields = line.split(separator: "\u{1F}", omittingEmptySubsequences: false).map(String.init)
            guard fields.count >= 7 else { return nil }
            let rollout = URL(fileURLWithPath: fields[1])
            guard FileManager.default.fileExists(atPath: rollout.path) else { return nil }
            let updatedAt = Date(timeIntervalSince1970: (Double(fields[4]) ?? 0) / 1000)
            let recencyAt = Date(timeIntervalSince1970: (Double(fields[5]) ?? 0) / 1000)
            return ThreadIndexRow(
                id: fields[0],
                rolloutPath: rollout,
                title: fields[2],
                preview: fields[3],
                updatedAt: updatedAt,
                recencyAt: recencyAt,
                cwd: fields[6]
            )
        }
    }

    private func parseDate(_ value: Any?) -> Date? {
        if let number = value as? NSNumber {
            let raw = number.doubleValue
            return Date(timeIntervalSince1970: raw > 1_000_000_000_000 ? raw / 1000 : raw)
        }
        guard let string = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) {
            return date
        }
        let fallback = ISO8601DateFormatter()
        fallback.formatOptions = [.withInternetDateTime]
        return fallback.date(from: string)
    }

    private func firstNonEmpty(_ values: String?...) -> String {
        for value in values {
            guard let value else { continue }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return "Codex 会话"
    }

    private func cleanDisplayText(_ value: String) -> String {
        var text = value
        text = text.replacingOccurrences(
            of: #"<oai-mem-citation>[\s\S]*?</oai-mem-citation>"#,
            with: "",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"!\[([^\]]*)\]\([^)]+\)"#,
            with: "$1",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"\[([^\]]+)\]\([^)]+\)"#,
            with: "$1",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"```[\s\S]*?```"#,
            with: " ",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"`([^`]+)`"#,
            with: "$1",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"\*\*|__"#,
            with: "",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("**"), text.hasSuffix("**") {
            text.removeFirst(2)
            text.removeLast(2)
        }
        return text
    }
}
