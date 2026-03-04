import SwiftUI
import ServiceManagement

struct ConnectedView: View {
    let userName: String
    @State private var launchAtLogin = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(Color.green).frame(width: 8, height: 8)
                Text("Claude Remote").font(.headline)
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

            Divider()

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
        }
    }
}
