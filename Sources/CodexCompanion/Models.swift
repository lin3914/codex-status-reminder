import Foundation

enum CompanionVersion {
    static let current = "1.9.14"
}

enum PopoverDirection {
    case up
    case down
}

enum QuotaHealth: String, Codable {
    case healthy
    case watch
    case critical
    case neutral

    var label: String {
        switch self {
        case .healthy: "健康"
        case .watch: "需关注"
        case .critical: "警示"
        case .neutral: "待同步"
        }
    }
}

enum CompanionTaskState: String, Codable {
    case unread
    case running
    case completed

    var rank: Int {
        switch self {
        case .unread: 0
        case .running: 1
        case .completed: 2
        }
    }
}

struct QuotaSnapshot: Equatable {
    var isAvailable = false
    var usedPercent: Double?
    var remainingPercent: Double?
    var timeRemainingPercent: Double?
    var resetAt: Date?
    var windowMinutes: Double?
    var source = "unavailable"

    var health: QuotaHealth {
        guard
            let usedPercent,
            let timeRemainingPercent
        else {
            return .neutral
        }

        let quotaUsed = usedPercent.clampedPercent
        let timeRemaining = timeRemainingPercent.clampedPercent
        let cycleDays = max(1, (windowMinutes ?? 10_080) / 1_440)
        let elapsedDays = (100 - timeRemaining) / 100 * cycleDays
        let currentDayEnd = min(cycleDays, floor(elapsedDays + Double.ulpOfOne) + 1)
        let usedEquivalentDays = quotaUsed / 100 * cycleDays
        let leadDays = usedEquivalentDays - currentDayEnd

        if leadDays >= 1 { return .critical }
        if leadDays > 0 { return .watch }
        return .healthy
    }

    var healthDescription: String {
        guard let usedPercent, let timeRemainingPercent else {
            return "额度或周期时间暂未同步"
        }
        let cycleDays = max(1, (windowMinutes ?? 10_080) / 1_440)
        let elapsedDays = (100 - timeRemainingPercent.clampedPercent) / 100 * cycleDays
        let currentDayEnd = min(cycleDays, floor(elapsedDays + Double.ulpOfOne) + 1)
        let usedEquivalentDays = usedPercent.clampedPercent / 100 * cycleDays
        let leadDays = usedEquivalentDays - currentDayEnd
        if leadDays > 0 {
            return "额度已用 \(Int(usedPercent.rounded()))%，已提前使用 \(String(format: "%.2f", leadDays)) 天额度"
        }
        return "额度已用 \(Int(usedPercent.rounded()))%，仍在今天累计可用额度内"
    }

    var resetCountdownText: String {
        guard let resetAt else { return "待同步" }
        let seconds = max(0, Int(resetAt.timeIntervalSinceNow.rounded()))
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60

        if days > 0 { return "\(days)天 \(hours)小时" }
        if hours > 0 { return "\(hours)小时 \(minutes)分钟" }
        if minutes > 0 { return "\(minutes)分钟" }
        return "不足 1 分钟"
    }
}

struct CompanionTask: Identifiable, Equatable {
    let id: String
    var title: String
    var latestProgress: String
    var state: CompanionTaskState
    var activityAt: Date
    var rolloutPath: URL?
    var cwd: String?
}

struct CompanionSnapshot: Equatable {
    var quota = QuotaSnapshot()
    var tasks: [CompanionTask] = []
    var unreadStateAvailable = false
    var lastUpdatedAt = Date()

    var runningCount: Int {
        tasks.lazy.filter { $0.state == .running }.count
    }

    var unreadCount: Int {
        tasks.lazy.filter { $0.state == .unread }.count
    }

    var retainedTasks: [CompanionTask] {
        TaskRetentionPolicy.retain(tasks)
    }

    var centerText: String {
        if unreadCount > 99 { return "99+" }
        if unreadCount > 0 { return "\(unreadCount)" }
        guard let remaining = quota.remainingPercent else { return "–" }
        return "\(Int(remaining.rounded()))"
    }
}

enum TaskRetentionPolicy {
    static func retain(_ tasks: [CompanionTask], baseline: Int = 10) -> [CompanionTask] {
        let sorted = tasks.sorted {
            if $0.state.rank != $1.state.rank {
                return $0.state.rank < $1.state.rank
            }
            if $0.activityAt != $1.activityAt {
                return $0.activityAt > $1.activityAt
            }
            return $0.id < $1.id
        }

        let priority = sorted.filter { $0.state == .unread || $0.state == .running }
        if priority.count >= baseline {
            return priority
        }

        let completed = sorted.filter { $0.state == .completed }
        return priority + completed.prefix(baseline - priority.count)
    }
}

extension Double {
    var clampedPercent: Double {
        min(100, max(0, self))
    }
}
