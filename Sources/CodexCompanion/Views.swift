import SwiftUI

struct StatusDotView: View {
    let snapshot: CompanionSnapshot

    private var health: HealthPalette {
        HealthPalette(snapshot.quota.health)
    }

    var body: some View {
        ZStack {
            PrecisionRing(
                consumedFraction: consumedTimeFraction,
                trackColor: Color(red: 0.769, green: 0.929, blue: 0.953),
                progressColor: Color(red: 0.396, green: 0.902, blue: 0.937),
                lineWidth: 4
            )
            .padding(1)

            PrecisionRing(
                consumedFraction: consumedQuotaFraction,
                trackColor: health.track,
                progressColor: health.ring,
                lineWidth: 4
            )
            .padding(5)

            Circle()
                .fill(health.center)
                .padding(9)

            centerLabel
        }
        .frame(width: 44, height: 44)
        .shadow(color: Color(red: 0.031, green: 0.09, blue: 0.133).opacity(0.16), radius: 8, y: 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var centerLabel: some View {
        let isTaskCount = snapshot.unreadCount > 0
        return Text(snapshot.centerText)
            .font(
                .system(
                    size: isTaskCount ? (snapshot.unreadCount > 99 ? 12 : 17) : 10.5,
                    weight: isTaskCount ? .semibold : .bold,
                    design: .rounded
                )
            )
            .tracking(isTaskCount ? -0.5 : -0.35)
            .foregroundStyle(health.ink)
            .minimumScaleFactor(0.7)
            .lineLimit(1)
            .frame(width: 25)
    }

    private var consumedQuotaFraction: Double {
        (snapshot.quota.usedPercent ?? 0).clampedPercent / 100
    }

    private var consumedTimeFraction: Double {
        (100 - (snapshot.quota.timeRemainingPercent ?? 100)).clampedPercent / 100
    }

    private var accessibilityText: String {
        let unread = "\(snapshot.unreadCount) 个已完成任务待查看"
        let running = "\(snapshot.runningCount) 个任务进行中"
        guard
            let quota = snapshot.quota.remainingPercent,
            let time = snapshot.quota.timeRemainingPercent
        else {
            return "\(unread)，\(running)，额度暂不可用"
        }
        return "\(unread)，\(running)，额度剩余 \(Int(quota.rounded()))%，时间剩余 \(Int(time.rounded()))%"
    }
}

private struct PrecisionRing: View {
    let consumedFraction: Double
    let trackColor: Color
    let progressColor: Color
    let lineWidth: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .stroke(trackColor, style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
            Circle()
                .trim(from: consumedFraction, to: 1)
                .stroke(progressColor, style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                .rotationEffect(.degrees(-90))
        }
    }
}

struct TaskPopoverView: View {
    let snapshot: CompanionSnapshot
    let direction: PopoverDirection
    let openTask: (String) -> Void

    private var health: HealthPalette {
        HealthPalette(snapshot.quota.health)
    }

    var body: some View {
        VStack(spacing: 0) {
            if direction == .down {
                arrow
            }
            content
            if direction == .up {
                arrow.rotationEffect(.degrees(180))
            }
        }
        .frame(width: 336)
    }

    private var content: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                InfoCard(
                    title: "额度剩余",
                    value: percent(snapshot.quota.remainingPercent),
                    tint: health.accent,
                    badge: snapshot.quota.health.label
                )
                InfoCard(
                    title: "时间剩余",
                    value: percent(snapshot.quota.timeRemainingPercent),
                    tint: Color(red: 0.471, green: 0.745, blue: 0.914)
                )
                InfoCard(
                    title: "重置倒计时",
                    value: snapshot.quota.resetCountdownText,
                    tint: .white.opacity(0.9),
                    compact: true
                )
            }

            if !snapshot.retainedTasks.isEmpty || snapshot.unreadCount > 0 || snapshot.runningCount > 0 {
                Divider().overlay(Color.white.opacity(0.09))

                HStack(spacing: 8) {
                    Circle()
                        .fill(health.accent)
                        .frame(width: 6, height: 6)
                        .shadow(color: health.accent.opacity(0.4), radius: 3)
                    Text("任务进展")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.94))
                    Spacer(minLength: 4)
                    if snapshot.unreadStateAvailable {
                        MetricPill(value: snapshot.unreadCount, label: "待查看", kind: .unread)
                    } else {
                        Text("未读状态不可用")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.46))
                            .lineLimit(1)
                    }
                    MetricPill(value: snapshot.runningCount, label: "进行中", kind: .running)
                }

                ScrollView(.vertical) {
                    LazyVStack(spacing: 6) {
                        ForEach(snapshot.retainedTasks) { task in
                            Button {
                                openTask(task.id)
                            } label: {
                                TaskRow(task: task)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .frame(height: taskListHeight)
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(red: 0.051, green: 0.09, blue: 0.122).opacity(0.94))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color(red: 0.733, green: 0.863, blue: 0.933).opacity(0.16), lineWidth: 1)
                )
                .shadow(color: Color(red: 0.016, green: 0.047, blue: 0.075).opacity(0.3), radius: 22, y: 10)
        )
    }

    private var arrow: some View {
        Triangle()
            .fill(Color(red: 0.051, green: 0.09, blue: 0.122).opacity(0.94))
            .frame(width: 18, height: 8)
    }

    private var taskListHeight: CGFloat {
        let rows = min(max(snapshot.retainedTasks.count, 1), 3)
        return CGFloat(rows * 82 + max(0, rows - 1) * 6)
    }

    private func percent(_ value: Double?) -> String {
        guard let value else { return "–" }
        return "\(Int(value.rounded()))%"
    }
}

private struct InfoCard: View {
    let title: String
    let value: String
    let tint: Color
    var compact = false
    var badge: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 3) {
                Text(title)
                    .font(.system(size: 9))
                    .foregroundStyle(.white.opacity(0.48))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let badge {
                    Text(badge)
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(tint)
                        .lineLimit(1)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 1)
                        .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(tint.opacity(0.27), lineWidth: 1)
                        )
                }
            }
            Spacer()
            Text(value)
                .font(.system(size: compact ? 12 : 16, weight: .bold))
                .tracking(compact ? -0.2 : -0.45)
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 58, maxHeight: 58, alignment: .leading)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(tint.opacity(0.16), lineWidth: 1)
        )
    }
}

private enum MetricKind {
    case unread
    case running

    var foreground: Color {
        switch self {
        case .unread: Color(red: 0.608, green: 0.851, blue: 0.953)
        case .running: Color(red: 0.482, green: 0.847, blue: 0.761)
        }
    }
}

private struct MetricPill: View {
    let value: Int
    let label: String
    let kind: MetricKind

    var body: some View {
        HStack(spacing: 4) {
            Text(value > 99 ? "99+" : "\(value)")
                .font(.system(size: 12, weight: .bold))
            Text(label)
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundStyle(value == 0 ? Color.white.opacity(0.42) : kind.foreground)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(
            (value == 0 ? Color.white.opacity(0.035) : kind.foreground.opacity(0.11)),
            in: RoundedRectangle(cornerRadius: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(
                    value == 0 ? Color.white.opacity(0.07) : kind.foreground.opacity(0.2),
                    lineWidth: 1
                )
        )
    }
}

private struct TaskRow: View {
    let task: CompanionTask

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(task.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.94))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(stateLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(stateColor)
                    .padding(.horizontal, 7)
                    .frame(height: 20)
                    .background(stateColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(stateColor.opacity(0.24), lineWidth: 1)
                    )
            }
            Text(task.latestProgress)
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.62))
                .lineSpacing(2)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 82, maxHeight: 82, alignment: .topLeading)
        .background(Color(red: 0.878, green: 0.945, blue: 0.98).opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(red: 0.761, green: 0.863, blue: 0.922).opacity(0.09), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }

    private var stateLabel: String {
        switch task.state {
        case .unread: "待查看"
        case .running: "进行中"
        case .completed: "已完成"
        }
    }

    private var stateColor: Color {
        switch task.state {
        case .unread: Color(red: 0.608, green: 0.851, blue: 0.953)
        case .running: Color(red: 0.482, green: 0.847, blue: 0.761)
        case .completed: Color(red: 0.718, green: 0.788, blue: 0.824)
        }
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct HealthPalette {
    let accent: Color
    let center: Color
    let ring: Color
    let track: Color
    let ink: Color

    init(_ health: QuotaHealth) {
        switch health {
        case .healthy:
            accent = Color(red: 0.153, green: 0.8, blue: 0.561)
            center = Color(red: 0.91, green: 1, blue: 0.969)
            ring = Color(red: 0.412, green: 0.933, blue: 0.682)
            track = Color(red: 0.788, green: 0.949, blue: 0.875)
            ink = Color(red: 0.063, green: 0.247, blue: 0.216)
        case .watch:
            accent = Color(red: 0.831, green: 0.71, blue: 0.322)
            center = Color(red: 1, green: 0.965, blue: 0.855)
            ring = Color(red: 0.831, green: 0.71, blue: 0.322)
            track = Color(red: 0.937, green: 0.882, blue: 0.714)
            ink = Color(red: 0.341, green: 0.263, blue: 0.086)
        case .critical:
            accent = Color(red: 0.843, green: 0.471, blue: 0.31)
            center = Color(red: 1, green: 0.906, blue: 0.847)
            ring = Color(red: 0.843, green: 0.471, blue: 0.31)
            track = Color(red: 0.953, green: 0.8, blue: 0.71)
            ink = Color(red: 0.345, green: 0.184, blue: 0.106)
        case .neutral:
            accent = Color(red: 0.651, green: 0.769, blue: 0.784)
            center = Color(red: 0.929, green: 0.961, blue: 0.957)
            ring = Color(red: 0.439, green: 0.576, blue: 0.604)
            track = Color(red: 0.827, green: 0.886, blue: 0.886)
            ink = Color(red: 0.165, green: 0.255, blue: 0.275)
        }
    }
}
