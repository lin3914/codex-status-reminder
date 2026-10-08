import AppKit
import WebKit

@MainActor
private protocol LegacyScriptTarget: AnyObject {
    func receiveScriptMessage(_ body: Any)
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any LegacyScriptTarget)?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let body = message.body
        Task { @MainActor [weak target] in
            target?.receiveScriptMessage(body)
        }
    }
}

@MainActor
final class HoverTrackingView: NSView {
    var onEnter: (() -> Void)?
    var onLeave: (() -> Void)?
    private var hoverTrackingArea: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTrackingArea {
            removeTrackingArea(hoverTrackingArea)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        hoverTrackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        onEnter?()
    }

    override func mouseExited(with event: NSEvent) {
        onLeave?()
    }
}

@MainActor
final class LegacyDotWebView: WKWebView, WKNavigationDelegate, LegacyScriptTarget {
    var onEnter: (() -> Void)?
    var onLeave: (() -> Void)?
    var onClick: (() -> Void)?
    var onDragStart: (() -> Void)?
    var onMove: ((_ dx: CGFloat, _ dy: CGFloat) -> Void)?
    var onDragEnd: (() -> Void)?

    private let messageHandler: WeakScriptMessageHandler
    private var latestSnapshot = CompanionSnapshot()
    private var pageReady = false

    init(frame: NSRect) {
        let configuration = WKWebViewConfiguration()
        let handler = WeakScriptMessageHandler()
        configuration.userContentController.add(handler, name: "dot")
        messageHandler = handler
        super.init(frame: frame, configuration: configuration)
        handler.target = self
        navigationDelegate = self
        configureTransparency()
        loadLegacyPage(named: "dot")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    func render(snapshot: CompanionSnapshot) {
        latestSnapshot = snapshot
        guard pageReady else { return }
        evaluateStateScript(
            function: "renderStatusDot",
            object: Self.dotState(from: snapshot)
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        render(snapshot: latestSnapshot)
    }

    fileprivate func receiveScriptMessage(_ body: Any) {
        guard
            let payload = body as? [String: Any],
            let type = payload["type"] as? String
        else {
            return
        }
        switch type {
        case "ready":
            pageReady = true
            render(snapshot: latestSnapshot)
        case "enter":
            onEnter?()
        case "leave":
            onLeave?()
        case "click":
            onClick?()
        case "dragStart":
            onDragStart?()
        case "move":
            let dx = (payload["dx"] as? NSNumber)?.doubleValue ?? 0
            let dy = (payload["dy"] as? NSNumber)?.doubleValue ?? 0
            onMove?(CGFloat(dx), CGFloat(dy))
        case "dragEnd":
            onDragEnd?()
        default:
            break
        }
    }

    private static func dotState(from snapshot: CompanionSnapshot) -> [String: Any] {
        let quotaRemaining = snapshot.quota.remainingPercent ?? 0
        let timeRemaining = snapshot.quota.timeRemainingPercent ?? 0
        return [
            "health": healthName(snapshot.quota.health),
            "quotaAvailable": snapshot.quota.isAvailable,
            "quotaRemainingPercent": quotaRemaining,
            "timeRemainingPercent": timeRemaining,
            "unreadCount": snapshot.unreadCount,
            "runningCount": snapshot.runningCount,
            "accessibilityLabel": accessibilityText(snapshot),
        ]
    }

    private static func accessibilityText(_ snapshot: CompanionSnapshot) -> String {
        let taskLabel = "\(snapshot.unreadCount) 个已完成任务待查看，\(snapshot.runningCount) 个任务进行中"
        guard
            let quota = snapshot.quota.remainingPercent,
            let time = snapshot.quota.timeRemainingPercent
        else {
            return "\(taskLabel)。本周额度暂不可用。单击打开 Codex；拖动调整位置"
        }
        return "\(taskLabel)。外环显示本周期剩余时间约 \(Int(time.rounded()))%，内环显示本周额度剩余 \(Int(quota.rounded()))%。单击打开 Codex；拖动调整位置"
    }
}

@MainActor
final class LegacyPanelWebView: WKWebView, WKNavigationDelegate, LegacyScriptTarget {
    var onEnter: (() -> Void)?
    var onLeave: (() -> Void)?
    var onOpenTask: ((String) -> Void)?
    var onResize: ((CGFloat) -> Void)?

    private let messageHandler: WeakScriptMessageHandler
    private var latestSnapshot = CompanionSnapshot()
    private var latestDirection: PopoverDirection = .down
    private var pageReady = false

    init(frame: NSRect) {
        let configuration = WKWebViewConfiguration()
        let handler = WeakScriptMessageHandler()
        configuration.userContentController.add(handler, name: "panel")
        messageHandler = handler
        super.init(frame: frame, configuration: configuration)
        handler.target = self
        navigationDelegate = self
        configureTransparency()
        loadLegacyPage(named: "panel")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    func render(snapshot: CompanionSnapshot, direction: PopoverDirection) {
        latestSnapshot = snapshot
        latestDirection = direction
        guard pageReady else { return }
        evaluateStateScript(
            function: "renderTaskPanel",
            object: Self.panelState(from: snapshot, direction: direction)
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        render(snapshot: latestSnapshot, direction: latestDirection)
    }

    fileprivate func receiveScriptMessage(_ body: Any) {
        guard
            let payload = body as? [String: Any],
            let type = payload["type"] as? String
        else {
            return
        }
        switch type {
        case "ready":
            pageReady = true
            render(snapshot: latestSnapshot, direction: latestDirection)
        case "enter":
            onEnter?()
        case "leave":
            onLeave?()
        case "openTask":
            if let id = payload["id"] as? String {
                onOpenTask?(id)
            }
        case "resize":
            if let height = (payload["height"] as? NSNumber)?.doubleValue {
                onResize?(CGFloat(height))
            }
        default:
            break
        }
    }

    private static func panelState(
        from snapshot: CompanionSnapshot,
        direction: PopoverDirection
    ) -> [String: Any] {
        let tasks = snapshot.retainedTasks.map { task -> [String: Any] in
            let stateLabel: String
            let stateClass: String
            switch task.state {
            case .unread:
                stateLabel = "待查看"
                stateClass = "unread"
            case .running:
                stateLabel = "进行中"
                stateClass = "running"
            case .completed:
                stateLabel = "已完成"
                stateClass = "completed"
            }
            return [
                "id": task.id,
                "title": task.title,
                "progress": task.latestProgress,
                "stateLabel": stateLabel,
                "stateClass": stateClass,
            ]
        }
        return [
            "direction": direction == .down ? "down" : "up",
            "health": healthName(snapshot.quota.health),
            "healthLabel": snapshot.quota.health.label,
            "healthDescription": snapshot.quota.healthDescription,
            "quotaValue": percent(snapshot.quota.remainingPercent),
            "timeValue": percent(snapshot.quota.timeRemainingPercent),
            "resetValue": snapshot.quota.isAvailable
                ? snapshot.quota.resetCountdownText
                : "待同步",
            "unreadCount": snapshot.unreadCount,
            "runningCount": snapshot.runningCount,
            "tasks": tasks,
        ]
    }
}

private extension WKWebView {
    @MainActor
    func configureTransparency() {
        setValue(false, forKey: "drawsBackground")
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    @MainActor
    func loadLegacyPage(named name: String) {
        guard
            let directory = Bundle.main.resourceURL?.appendingPathComponent("LegacyV11", isDirectory: true),
            let url = Bundle.main.url(
                forResource: name,
                withExtension: "html",
                subdirectory: "LegacyV11"
            )
        else {
            return
        }
        loadFileURL(url, allowingReadAccessTo: directory)
    }

    @MainActor
    func evaluateStateScript(function: String, object: [String: Any]) {
        guard
            JSONSerialization.isValidJSONObject(object),
            let data = try? JSONSerialization.data(withJSONObject: object),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        evaluateJavaScript("window.\(function)?.(\(json));")
    }
}

private func healthName(_ health: QuotaHealth) -> String {
    switch health {
    case .healthy: "healthy"
    case .watch: "watch"
    case .critical: "critical"
    case .neutral: "neutral"
    }
}

private func percent(_ value: Double?) -> String {
    guard let value else { return "–" }
    return "\(Int(value.rounded()))%"
}
