import SwiftUI
import Combine

@main
struct ClaudeRemoteApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        Settings { EmptyView() }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.action = #selector(togglePopover)
            btn.target = self
        }

        popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: PopoverView().environmentObject(AppState.shared)
        )

        AppState.shared.$connectionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.updateIcon(state) }
            .store(in: &cancellables)

        AgentService.shared.startIfCredentialed()

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { _ in
            AgentService.shared.stop()
            AgentService.shared.startIfCredentialed()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        AgentService.shared.stop()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        AuthService.shared.handleCallback(url: url)
    }

    @objc private func togglePopover() {
        guard let btn = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: btn.bounds, of: btn, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func updateIcon(_ state: ConnectionState) {
        if case .connected = state {
            statusItem.button?.image = menuBarImage(connected: true)
        } else {
            statusItem.button?.image = menuBarImage(connected: false)
        }
    }

    private func menuBarImage(connected: Bool) -> NSImage {
        let base = NSImage(named: "MenuBarIcon")!
        base.isTemplate = true
        guard connected else { return base }
        let size = NSSize(width: 18, height: 18)
        let composite = NSImage(size: size)
        composite.lockFocus()
        base.draw(in: NSRect(origin: .zero, size: size))
        NSColor.systemGreen.setFill()
        NSBezierPath(ovalIn: NSRect(x: 11, y: 0, width: 7, height: 7)).fill()
        composite.unlockFocus()
        return composite
    }
}
