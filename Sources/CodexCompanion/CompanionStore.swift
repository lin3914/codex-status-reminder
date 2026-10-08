import Combine
import Foundation

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var snapshot = CompanionSnapshot()

    private let appServer = CodexAppServerClient()
    private let unreadReader = CodexUnreadStateReader()
    private let transcriptReader = CodexTranscriptReader()
    private var refreshLoop: Task<Void, Never>?
    private var lastAppServerSnapshot: AppServerDataSnapshot?
    private var lastAppServerFetchAt = Date.distantPast

    func start() {
        guard refreshLoop == nil else { return }
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        refreshLoop?.cancel()
        refreshLoop = nil
        Task { await appServer.stop() }
    }

    func refresh() async {
        if Date().timeIntervalSince(lastAppServerFetchAt) >= 30 || lastAppServerSnapshot == nil {
            do {
                lastAppServerSnapshot = try await appServer.fetchSnapshot()
                lastAppServerFetchAt = Date()
            } catch {
                lastAppServerFetchAt = Date()
            }
        }

        let unreadState = await Task.detached(priority: .utility) { [unreadReader] in
            unreadReader.read()
        }.value
        let serverSnapshot = lastAppServerSnapshot
        let tasks = await Task.detached(priority: .utility) { [transcriptReader] in
            transcriptReader.readTasks(
                unreadState: unreadState
            )
        }.value

        var next = snapshot
        if let serverSnapshot {
            next.quota = serverSnapshot.quota
        }
        next.tasks = tasks
        next.unreadStateAvailable = unreadState.isAvailable
        next.lastUpdatedAt = Date()
        snapshot = next
    }
}
