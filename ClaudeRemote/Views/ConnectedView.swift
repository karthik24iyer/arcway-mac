import SwiftUI
import ServiceManagement

struct ConnectedView: View {
    let userName: String
    @State private var launchAtLogin = false
    @State private var hasFullDiskAccess: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(Color.green).frame(width: 8, height: 8)
                Text("Arcway").font(.headline)
            }
            Text("Hello, \(userName)").font(.subheadline)
            Text("Connected").font(.caption).foregroundColor(.secondary)

            Divider()

            Toggle("Launch at login", isOn: $launchAtLogin)
                .font(.subheadline)
                .onChange(of: launchAtLogin) { enabled in
                    if #available(macOS 13.0, *) {
                        try? enabled ? SMAppService.mainApp.register()
                                     : SMAppService.mainApp.unregister()
                    }
                }

            HStack(spacing: 6) {
                Image(systemName: hasFullDiskAccess ? "checkmark.circle.fill" : "exclamationmark.circle")
                    .foregroundColor(hasFullDiskAccess ? .green : .orange)
                Button(hasFullDiskAccess ? "Disk access granted" : "Allow disk access") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllDiskAccess")!)
                }
                .buttonStyle(.plain)
                .foregroundColor(hasFullDiskAccess ? .secondary : .orange)
                .disabled(hasFullDiskAccess)
            }
            .font(.subheadline)

            Divider()

            Button("Reconnect") {
                AgentService.shared.stop()
                AgentService.shared.startIfCredentialed()
            }
            .buttonStyle(.plain)

            Button("Logout", role: .destructive) {
                AgentService.shared.stop()
                AuthService.shared.logout()
                AppState.shared.connectionState = .loggedOut
            }
            .buttonStyle(.plain)
            .foregroundColor(.red)

            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
        }
        .onAppear {
            if #available(macOS 13.0, *) {
                launchAtLogin = SMAppService.mainApp.status == .enabled
            }
            checkFullDiskAccess()
        }
    }

    private func checkFullDiskAccess() {
        // TCC.db is only readable with full disk access
        hasFullDiskAccess = FileManager.default.isReadableFile(atPath: "/Library/Application Support/com.apple.TCC/TCC.db")
    }
}
