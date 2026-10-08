import AppKit
import SwiftUI

private struct CompanionPreview: View {
    let snapshot: CompanionSnapshot

    var body: some View {
        VStack(spacing: 2) {
            StatusDotView(snapshot: snapshot)
                .padding(.top, 10)
            TaskPopoverView(
                snapshot: snapshot,
                direction: .down,
                openTask: { _ in }
            )
        }
        .frame(width: 356, height: 455, alignment: .top)
        .background(Color.white)
    }
}

@main
private struct PreviewRenderer {
    @MainActor
    static func main() {
        let now = Date()
        var snapshot = CompanionSnapshot(
            quota: QuotaSnapshot(
                isAvailable: true,
                usedPercent: 16,
                remainingPercent: 84,
                timeRemainingPercent: 96,
                resetAt: now.addingTimeInterval(6 * 86_400 + 18 * 3_600),
                windowMinutes: 10_080,
                source: "preview"
            ),
            tasks: [
                task(
                    "待查看任务",
                    "已完成本地未读状态适配，正在等待你打开会话查看最终结果。",
                    .unread,
                    now
                ),
                task(
                    "独立组件安装与联调",
                    "正在验证 LaunchAgent、自启动和 Codex 任务进展的实时刷新。",
                    .running,
                    now.addingTimeInterval(-60)
                ),
                task(
                    "圆环视觉校准",
                    "内外环已统一从 12 点钟方向按顺时针展开，并改用平头切片。",
                    .completed,
                    now.addingTimeInterval(-120)
                ),
            ],
            unreadStateAvailable: true,
            lastUpdatedAt: now
        )
        snapshot.tasks = TaskRetentionPolicy.retain(snapshot.tasks)

        let size = NSSize(width: 356, height: 455)
        let hosting = NSHostingView(rootView: CompanionPreview(snapshot: snapshot))
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()

        guard
            let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)
        else {
            Foundation.exit(1)
        }
        bitmap.size = size
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            Foundation.exit(1)
        }

        let target = CommandLine.arguments.dropFirst().first
            ?? FileManager.default.currentDirectoryPath + "/dist/codex-companion-preview.png"
        do {
            try png.write(to: URL(fileURLWithPath: target), options: .atomic)
            print(target)
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }

    private static func task(
        _ title: String,
        _ progress: String,
        _ state: CompanionTaskState,
        _ date: Date
    ) -> CompanionTask {
        CompanionTask(
            id: UUID().uuidString,
            title: title,
            latestProgress: progress,
            state: state,
            activityAt: date,
            rolloutPath: nil,
            cwd: nil
        )
    }
}
