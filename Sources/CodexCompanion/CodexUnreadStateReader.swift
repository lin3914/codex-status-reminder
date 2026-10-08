import Foundation
import CryptoKit

struct CodexUnreadState: Equatable {
    let threadIDs: Set<String>
    let isAvailable: Bool
}

struct CodexUnreadStateReader {
    static let atomStateKey = "electron-persisted-atom-state"
    static let unreadStateKey = "unread-thread-ids-by-host-v1"

    let stateURL: URL
    let authURL: URL
    let environment: [String: String]

    init(
        stateURL: URL = URL(fileURLWithPath:
            ProcessInfo.processInfo.environment["CODEX_HOME"]
                ?? FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent(".codex").path
        ).appendingPathComponent(".codex-global-state.json"),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.stateURL = stateURL
        self.authURL = stateURL.deletingLastPathComponent().appendingPathComponent("auth.json")
        self.environment = environment
    }

    func read() -> CodexUnreadState {
        guard
            let data = try? Data(contentsOf: stateURL, options: [.mappedIfSafe]),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return CodexUnreadState(threadIDs: [], isAvailable: false)
        }

        if root.keys.contains("electron-thread-read-state-v1") {
            guard
                let state = root["electron-thread-read-state-v1"] as? [String: Any],
                state["version"] as? Int == 1,
                let identityKey = readIdentityKey(),
                let identities = state["unreadByIdentity"] as? [String: Any],
                let hosts = identities[identityKey] as? [String: Any],
                let hostKey = localHostKey(),
                let local = hosts[hostKey] as? [Any]
            else { return CodexUnreadState(threadIDs: [], isAvailable: false) }
            return Self.result(local)
        }
        guard let atomState = root[Self.atomStateKey] as? [String: Any] else {
            return CodexUnreadState(threadIDs: [], isAvailable: false)
        }
        let candidates: [[Any]?] = [
            (atomState[Self.unreadStateKey] as? [String: Any])?["local"] as? [Any],
            (atomState["unread-thread-ids-by-host-v2"] as? [String: Any])?["local"] as? [Any],
            atomState["unread-thread-ids-v1"] as? [Any],
            atomState["unread-thread-ids"] as? [Any]
        ]
        let sources = candidates.compactMap { $0 }
        guard !sources.isEmpty else { return CodexUnreadState(threadIDs: [], isAvailable: false) }
        return Self.result(sources.flatMap { $0 })
    }

    private static func result(_ values: [Any]) -> CodexUnreadState {
        let ids = values.compactMap { value -> String? in
            guard let string = value as? String else { return nil }
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return CodexUnreadState(threadIDs: Set(ids), isAvailable: true)
    }

    private static func scopeHash(_ parts: [Any]) -> String? {
        guard let data = try? JSONSerialization.data(
            withJSONObject: parts, options: [.withoutEscapingSlashes]
        ) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func localHostKey() -> String? {
        let url = environment["CODEX_APP_SERVER_FORCE_CLI"] == "1"
            ? nil : environment["CODEX_APP_SERVER_WS_URL"].flatMap { $0.isEmpty ? nil : $0 }
        guard let hash = Self.scopeHash(["local", "local", url as Any? ?? NSNull()]) else { return nil }
        return "local:" + hash
    }

    private func readIdentityKey() -> String? {
        guard
            let data = try? Data(contentsOf: authURL),
            let auth = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let mode = auth["auth_mode"] as? String,
            !mode.isEmpty
        else { return nil }
        if mode != "chatgpt" && mode != "chatgptAuthTokens" {
            return Self.scopeHash(["execution-storage", mode])
        }
        // Decode the local selector only. No refresh / network / token logging.
        guard
            let tokens = auth["tokens"] as? [String: Any],
            let token = (tokens["access_token"] as? String) ?? (tokens["id_token"] as? String)
        else { return nil }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        var base64 = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard
            let payloadData = Data(base64Encoded: base64),
            let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
            let claims = payload["https://api.openai.com/auth"] as? [String: Any],
            let account = (claims["chatgpt_account_id"] as? String) ?? (claims["account_id"] as? String),
            let user = (claims["user_id"] as? String) ?? (claims["chatgpt_user_id"] as? String),
            !account.isEmpty, !user.isEmpty
        else { return nil }
        return Self.scopeHash(["chatgpt", account, user])
    }
}
