import AppKit
import Combine

@MainActor
final class CompanionWindowController: NSObject {
    private static let dotVisualSize = CGSize(width: 44, height: 44)
    private static let dotWindowSize = CGSize(width: 64, height: 64)
    private static let popoverWidth: CGFloat = 336
    private static let hoverOpenDelay = 0.18
    private static let hoverCloseDelay = 0.28
    private static let popoverGap: CGFloat = 2
    private static let popoverMaxHeight: CGFloat = 400

    private let store: CompanionStore
    private let dotPanel: NSPanel
    private let dotWebView: LegacyDotWebView
    private let dotTrackingView: HoverTrackingView
    private var popoverPanel: NSPanel?
    private var popoverWebView: LegacyPanelWebView?
    private var popoverTrackingView: HoverTrackingView?
    private var cancellables: Set<AnyCancellable> = []
    private var hoverOpenWorkItem: DispatchWorkItem?
    private var hoverCloseWorkItem: DispatchWorkItem?
    private var latestSnapshot = CompanionSnapshot()
    private var isDragging = false

    init(store: CompanionStore) {
        self.store = store
        dotPanel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.dotWindowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        dotTrackingView = HoverTrackingView(
            frame: NSRect(
                x: 10,
                y: 10,
                width: Self.dotVisualSize.width,
                height: Self.dotVisualSize.height
            )
        )
        dotWebView = LegacyDotWebView(
            frame: NSRect(origin: .zero, size: Self.dotVisualSize)
        )
        super.init()
        configureDotPanel()
        configureDotInteractions()
        bindStore()
    }

    func show() {
        restoreDotPosition()
        dotPanel.orderFrontRegardless()
        dotWebView.render(snapshot: latestSnapshot)
    }

    func close() {
        hoverOpenWorkItem?.cancel()
        hoverCloseWorkItem?.cancel()
        closePopover()
        dotPanel.close()
    }

    private func configureDotPanel() {
        dotPanel.isOpaque = false
        dotPanel.backgroundColor = .clear
        dotPanel.hasShadow = false
        dotPanel.level = .popUpMenu
        dotPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        dotPanel.hidesOnDeactivate = false
        dotPanel.ignoresMouseEvents = false
        dotPanel.isMovable = false
        dotPanel.isReleasedWhenClosed = false

        dotTrackingView.wantsLayer = true
        dotTrackingView.layer?.backgroundColor = NSColor.clear.cgColor
        dotTrackingView.autoresizingMask = []
        dotWebView.frame = dotTrackingView.bounds
        dotWebView.autoresizingMask = [.width, .height]
        dotTrackingView.addSubview(dotWebView)
        let root = NSView(
            frame: NSRect(origin: .zero, size: Self.dotWindowSize)
        )
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.clear.cgColor
        root.addSubview(dotTrackingView)
        dotPanel.contentView = root
    }

    private func configureDotInteractions() {
        dotTrackingView.onEnter = { [weak self] in
            self?.handleHoverEnter()
        }
        dotTrackingView.onLeave = { [weak self] in
            self?.handleHoverLeave()
        }
        dotWebView.onEnter = { [weak self] in
            self?.handleHoverEnter()
        }
        dotWebView.onLeave = { [weak self] in
            self?.handleHoverLeave()
        }
        dotWebView.onClick = { [weak self] in
            self?.activateCodex()
        }
        dotWebView.onDragStart = { [weak self] in
            guard let self else { return }
            isDragging = true
            closePopover()
        }
        dotWebView.onMove = { [weak self] dx, dy in
            self?.moveDot(dx: dx, electronDY: dy)
        }
        dotWebView.onDragEnd = { [weak self] in
            guard let self else { return }
            isDragging = false
            persistDotPosition()
        }
    }

    private func bindStore() {
        store.$snapshot
            .receive(on: RunLoop.main)
            .sink { [weak self] snapshot in
                guard let self else { return }
                latestSnapshot = snapshot
                dotWebView.render(snapshot: snapshot)
                renderPopoverIfNeeded()
            }
            .store(in: &cancellables)
    }

    private func handleHoverEnter() {
        hoverCloseWorkItem?.cancel()
        hoverCloseWorkItem = nil
        guard !isDragging, popoverPanel == nil, hoverOpenWorkItem == nil else { return }

        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            hoverOpenWorkItem = nil
            if !isDragging, popoverPanel == nil {
                openPopover()
            }
        }
        hoverOpenWorkItem = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.hoverOpenDelay,
            execute: work
        )
    }

    private func handleHoverLeave() {
        guard !isDragging else { return }
        hoverOpenWorkItem?.cancel()
        hoverOpenWorkItem = nil
        schedulePopoverClose()
    }

    private func openPopover() {
        guard popoverPanel == nil else { return }
        let initialHeight = estimatedPopoverHeight(for: latestSnapshot)
        let placement = calculatePopoverPlacement(height: initialHeight)
        let frame = panelFrame(for: placement, height: initialHeight)

        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.alphaValue = 0

        let trackingView = HoverTrackingView(
            frame: NSRect(
                x: 0,
                y: 0,
                width: Self.popoverWidth,
                height: initialHeight
            )
        )
        trackingView.wantsLayer = true
        trackingView.layer?.backgroundColor = NSColor.clear.cgColor
        trackingView.autoresizingMask = [.width, .height]
        trackingView.onEnter = { [weak self] in self?.popoverHoverEnter() }
        trackingView.onLeave = { [weak self] in self?.popoverHoverLeave() }

        let webView = LegacyPanelWebView(frame: trackingView.bounds)
        webView.autoresizingMask = [.width, .height]
        webView.onEnter = { [weak self] in self?.popoverHoverEnter() }
        webView.onLeave = { [weak self] in self?.popoverHoverLeave() }
        webView.onOpenTask = { [weak self] id in self?.openTask(id) }
        webView.onResize = { [weak self] height in
            self?.resizePopover(to: height)
        }
        trackingView.addSubview(webView)
        panel.contentView = trackingView

        popoverPanel = panel
        popoverTrackingView = trackingView
        popoverWebView = webView
        panel.orderFrontRegardless()
        webView.render(snapshot: latestSnapshot, direction: placement.direction)
    }

    private func renderPopoverIfNeeded() {
        guard
            let panel = popoverPanel,
            let webView = popoverWebView
        else {
            return
        }
        let height = max(1, panel.frame.height)
        let placement = calculatePopoverPlacement(height: height)
        webView.render(snapshot: latestSnapshot, direction: placement.direction)
    }

    private func resizePopover(to reportedHeight: CGFloat) {
        guard
            let panel = popoverPanel,
            let webView = popoverWebView
        else {
            return
        }
        let height = min(
            Self.popoverMaxHeight,
            max(1, ceil(reportedHeight))
        )
        let placement = calculatePopoverPlacement(height: height)
        panel.setFrame(panelFrame(for: placement, height: height), display: true)
        webView.render(snapshot: latestSnapshot, direction: placement.direction)
        if panel.alphaValue == 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak panel] in
                panel?.alphaValue = 1
            }
        }
    }

    private func popoverHoverEnter() {
        hoverCloseWorkItem?.cancel()
        hoverCloseWorkItem = nil
    }

    private func popoverHoverLeave() {
        schedulePopoverClose()
    }

    private func schedulePopoverClose() {
        hoverCloseWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            hoverCloseWorkItem = nil
            let mouse = NSEvent.mouseLocation
            let overDotVisual = dotVisualFrame.contains(mouse)
            let overPopover = popoverPanel?.frame.contains(mouse) == true
            if !overDotVisual && !overPopover {
                closePopover()
            }
        }
        hoverCloseWorkItem = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.hoverCloseDelay,
            execute: work
        )
    }

    private func closePopover() {
        popoverPanel?.close()
        popoverPanel = nil
        popoverWebView = nil
        popoverTrackingView = nil
    }

    private func moveDot(dx: CGFloat, electronDY: CGFloat) {
        guard dx != 0 || electronDY != 0 else { return }
        closePopover()
        let origin = dotPanel.frame.origin
        dotPanel.setFrameOrigin(
            NSPoint(
                x: origin.x + dx,
                y: origin.y - electronDY
            )
        )
    }

    private func openTask(_ id: String) {
        closePopover()
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            activateCodex()
            return
        }
        if let url = URL(string: "codex://threads/\(encoded)") {
            NSWorkspace.shared.open(url)
        } else {
            activateCodex()
        }
    }

    private func activateCodex() {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        if let url = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: "com.openai.codex"
        ) {
            NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        }
    }

    private func estimatedPopoverHeight(for snapshot: CompanionSnapshot) -> CGFloat {
        let rows = min(snapshot.retainedTasks.count, 3)
        if rows == 0 {
            return 86
        }
        return min(128 + CGFloat(rows * 88), Self.popoverMaxHeight)
    }

    private struct PopoverPlacement {
        let x: CGFloat
        let direction: PopoverDirection
        let dotVisualFrame: NSRect
    }

    private var dotVisualFrame: NSRect {
        NSRect(
            x: dotPanel.frame.midX - Self.dotVisualSize.width / 2,
            y: dotPanel.frame.midY - Self.dotVisualSize.height / 2,
            width: Self.dotVisualSize.width,
            height: Self.dotVisualSize.height
        )
    }

    private func calculatePopoverPlacement(height: CGFloat) -> PopoverPlacement {
        let visualFrame = dotVisualFrame
        let screen = NSScreen.screens.first(
            where: { $0.frame.intersects(dotPanel.frame) }
        ) ?? NSScreen.main
        let workArea = screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let spaceBelow = visualFrame.minY - workArea.minY
        let spaceAbove = workArea.maxY - visualFrame.maxY
        let direction: PopoverDirection =
            spaceBelow >= height + Self.popoverGap || spaceBelow >= spaceAbove
            ? .down
            : .up
        let desiredX = visualFrame.midX - Self.popoverWidth / 2
        let x = min(
            max(desiredX, workArea.minX),
            workArea.maxX - Self.popoverWidth
        )
        return PopoverPlacement(
            x: x,
            direction: direction,
            dotVisualFrame: visualFrame
        )
    }

    private func panelFrame(
        for placement: PopoverPlacement,
        height: CGFloat
    ) -> NSRect {
        let y: CGFloat
        switch placement.direction {
        case .down:
            y = placement.dotVisualFrame.minY - Self.popoverGap - height
        case .up:
            y = placement.dotVisualFrame.maxY + Self.popoverGap
        }
        return NSRect(
            x: placement.x,
            y: y,
            width: Self.popoverWidth,
            height: height
        )
    }

    private func restoreDotPosition() {
        let defaults = UserDefaults.standard
        let hasPosition = defaults.object(forKey: "dotCenterX") != nil
            && defaults.object(forKey: "dotCenterY") != nil
        let center: NSPoint
        if hasPosition {
            center = NSPoint(
                x: defaults.double(forKey: "dotCenterX"),
                y: defaults.double(forKey: "dotCenterY")
            )
        } else if let fluxCenter = readFluxDotCenter() {
            center = fluxCenter
        } else if let screen = NSScreen.main {
            center = NSPoint(
                x: screen.visibleFrame.midX,
                y: screen.visibleFrame.midY
            )
        } else {
            center = NSPoint(x: 400, y: 400)
        }

        dotPanel.setFrame(
            NSRect(
                x: center.x - Self.dotWindowSize.width / 2,
                y: center.y - Self.dotWindowSize.height / 2,
                width: Self.dotWindowSize.width,
                height: Self.dotWindowSize.height
            ),
            display: false
        )
    }

    private func persistDotPosition() {
        UserDefaults.standard.set(dotPanel.frame.midX, forKey: "dotCenterX")
        UserDefaults.standard.set(dotPanel.frame.midY, forKey: "dotCenterY")
    }

    private func readFluxDotCenter() -> NSPoint? {
        let settingsURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(
                "Library/Application Support/flux-desktop-app/settings.json"
            )
        guard
            let data = try? Data(contentsOf: settingsURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let position = root["statusDotPosition"] as? [String: Any],
            let x = (position["x"] as? NSNumber)?.doubleValue,
            let electronY = (position["y"] as? NSNumber)?.doubleValue,
            let screen = screenContainingElectronPoint(x: x, y: electronY)
        else {
            return nil
        }

        let cocoaY = screen.frame.maxY - (
            electronY - electronScreenOriginY(for: screen)
        )
        return NSPoint(x: x, y: cocoaY)
    }

    private func screenContainingElectronPoint(x: Double, y: Double) -> NSScreen? {
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        return NSScreen.screens.first { screen in
            let electronMinY = primaryTop - screen.frame.maxY
            let electronMaxY = primaryTop - screen.frame.minY
            return x >= screen.frame.minX
                && x <= screen.frame.maxX
                && y >= electronMinY
                && y <= electronMaxY
        }
    }

    private func electronScreenOriginY(for screen: NSScreen) -> Double {
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        return primaryTop - screen.frame.maxY
    }
}
