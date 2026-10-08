import Foundation

private enum SelfTestFailure: LocalizedError {
    case assertion(String)

    var errorDescription: String? {
        switch self {
        case .assertion(let message): message
        }
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else {
        throw SelfTestFailure.assertion(message)
    }
}

@main
private struct SelfTest {
    static func main() async {
        do {
            try unreadSchemaTest()
            try retentionPolicyTest()
            try quotaHealthTest()
            try transcriptStateTest()
            print("PASS swift-unit-fixtures=4")
            guard ProcessInfo.processInfo.environment["CODEX_COMPANION_LIVE_TESTS"] == "1" else {
                print("SKIP live Codex checks (opt in with CODEX_COMPANION_LIVE_TESTS=1)")
                return
            }
            let liveUnread = try liveUnreadTest()
            let liveTasks = try liveTranscriptTest()
            let liveServer = try await liveAppServerTest()
            print(
                "PASS unit=4 unreadIDs=\(liveUnread) tasks=\(liveTasks.total) "
                    + "unreadTasks=\(liveTasks.unread) runningTasks=\(liveTasks.running) "
                    + "quota=\(liveServer)%"
            )
        } catch {
            FileHandle.standardError.write(Data("FAIL \(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }

    private static func unreadSchemaTest() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent("state.json")
        let payload: [String: Any] = [
            "electron-persisted-atom-state": [
                "unread-thread-ids-by-host-v1": [
                    "local": ["thread-a", "thread-b"],
                    "remote": ["thread-c"],
                ],
            ],
        ]
        try JSONSerialization.data(withJSONObject: payload).write(to: url)
        let result = CodexUnreadStateReader(stateURL: url).read()
        try require(result.isAvailable, "未读字段存在时应标记为可用")
        try require(result.threadIDs == Set(["thread-a", "thread-b"]), "只能读取 local 未读集合")

        let authURL = directory.appendingPathComponent("auth.json")
        func auth(_ account: String, _ user: String) throws -> [String: Any] {
            let claims = ["https://api.openai.com/auth": [
                "chatgpt_account_id": account, "user_id": user
            ]]
            let data = try JSONSerialization.data(withJSONObject: claims)
            let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            return ["auth_mode": "chatgpt", "tokens": ["access_token": "test.\(encoded).test"]]
        }
        let identity = "8a3d88b13bf9c1bf43b3123ba74b011bee7a5dc05698de76d910fb86ddb8d550"
        let otherIdentity = "baad1439b0911611b212cc543c02daa1b01f57686484df1bc740a2e87af6df33"
        let host = "local:092af2cb59bdd804c6f7f1cd1d85464b682974e43cd517397d25510024034d1c"
        var state: [String: Any] = [
            "version": 1,
            "unreadByIdentity": [
                identity: [host: ["current"], "local:stale": ["stale-host"], "remote:one": ["remote"]],
                otherIdentity: [host: ["other-account"]]
            ],
            "legacyMigration": ["unreadThreadIdsByHostId": ["local": ["migration-stale"]]]
        ]
        func writeState() throws {
            var root = payload
            root["electron-thread-read-state-v1"] = state
            try JSONSerialization.data(withJSONObject: root).write(to: url)
        }
        try JSONSerialization.data(withJSONObject: auth("account-a", "user-a")).write(to: authURL)
        try writeState()
        let reader = CodexUnreadStateReader(stateURL: url, environment: [:])
        try require(reader.read() == CodexUnreadState(threadIDs: ["current"], isAvailable: true), "新未读结构必须隔离账户、主机和旧迁移数据")
        try JSONSerialization.data(withJSONObject: auth("account-b", "user-b")).write(to: authURL)
        try require(reader.read().threadIDs == ["other-account"], "切换账户后不得读取上一账户")
        try JSONSerialization.data(withJSONObject: auth("account-a", "user-a")).write(to: authURL)
        state["unreadByIdentity"] = [identity: [host: [String]()]]
        try writeState()
        try require(reader.read() == CodexUnreadState(threadIDs: [], isAvailable: true), "新结构空集合不得回退到旧未读记录")
        state["version"] = 2
        try writeState()
        try require(!reader.read().isAvailable, "未知版本不能当作全部已读")
        state["version"] = 1
        try writeState()
        try JSONSerialization.data(withJSONObject: ["auth_mode": "chatgpt", "tokens": [:]]).write(to: authURL)
        try require(!reader.read().isAvailable, "账户不可用时不得当作全部已读")
    }

    private static func retentionPolicyTest() throws {
        let now = Date()
        let unread = (0..<7).map {
            task(id: "unread-\($0)", state: .unread, at: now.addingTimeInterval(Double(-$0)))
        }
        let running = (0..<6).map {
            task(id: "running-\($0)", state: .running, at: now.addingTimeInterval(Double(-$0)))
        }
        let completed = (0..<12).map {
            task(id: "completed-\($0)", state: .completed, at: now.addingTimeInterval(Double(-$0)))
        }
        let retained = TaskRetentionPolicy.retain(unread + running + completed)
        try require(retained.count == 13, "优先任务超过 10 个时必须全部保留")
        try require(retained.prefix(7).allSatisfy { $0.state == .unread }, "待查看必须排在最前")
        try require(retained.dropFirst(7).allSatisfy { $0.state == .running }, "进行中必须排在待查看之后")
    }

    private static func quotaHealthTest() throws {
        let healthy = QuotaSnapshot(
            isAvailable: true,
            usedPercent: 57,
            remainingPercent: 43,
            timeRemainingPercent: 50
        )
        try require(healthy.health == .healthy, "额度略快于时间时应保持健康")
        try require(healthy.health.label == "健康", "健康态标签不正确")
        try require(CompanionSnapshot(quota: healthy).centerText == "43", "圆心额度不应携带百分号")

        let watch = QuotaSnapshot(
            isAvailable: true,
            usedPercent: 65,
            remainingPercent: 35,
            timeRemainingPercent: 50
        )
        try require(watch.health == .watch, "额度明显快于时间时应提示关注")

        let critical = QuotaSnapshot(
            isAvailable: true,
            usedPercent: 75,
            remainingPercent: 25,
            timeRemainingPercent: 50
        )
        try require(critical.health == .critical, "额度远快于时间时应重点关注")
    }

    private static func transcriptStateTest() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent("rollout.jsonl")
        let lines = [
            #"{"timestamp":"2026-08-13T08:00:00.000Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-08-13T08:00:01.000Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"正在校验只读状态"}}"#,
        ].joined(separator: "\n")
        try Data(lines.utf8).write(to: url)

        let observation = CodexTranscriptReader().readObservation(from: url)
        try require(observation.isRunning, "task_started 后应识别为进行中")
        try require(observation.latestProgress == "正在校验只读状态", "应提取最新推理文本")
    }

    private static func liveUnreadTest() throws -> Int {
        let result = CodexUnreadStateReader().read()
        try require(result.isAvailable, "Codex 本地未读字段当前不可用")
        return result.threadIDs.count
    }

    private static func liveTranscriptTest() throws -> (total: Int, unread: Int, running: Int) {
        let tasks = CodexTranscriptReader().readTasks(
            unreadState: CodexUnreadStateReader().read()
        )
        try require(!tasks.isEmpty, "未从 Codex 本地会话索引读取到任务")
        try require(tasks.allSatisfy { !$0.title.isEmpty }, "任务标题不能为空")
        return (
            tasks.count,
            tasks.filter { $0.state == .unread }.count,
            tasks.filter { $0.state == .running }.count
        )
    }

    private static func liveAppServerTest() async throws -> Int {
        let client = CodexAppServerClient()
        let snapshot = try await client.fetchSnapshot()
        await client.stop()
        try require(snapshot.quota.isAvailable, "app-server 未返回周额度")
        return Int((snapshot.quota.remainingPercent ?? 0).rounded())
    }

    private static func task(
        id: String,
        state: CompanionTaskState,
        at date: Date
    ) -> CompanionTask {
        CompanionTask(
            id: id,
            title: id,
            latestProgress: "",
            state: state,
            activityAt: date,
            rolloutPath: nil,
            cwd: nil
        )
    }
}
