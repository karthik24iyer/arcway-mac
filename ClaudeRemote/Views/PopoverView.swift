import SwiftUI

struct PopoverView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        Group {
            switch appState.connectionState {
            case .loggedOut:
                LoginView()
            case .connecting:
                ConnectingView()
            case .connected(let name):
                ConnectedView(userName: name)
            case .error(let msg):
                ErrorView(message: msg)
            }
        }
        .frame(width: 240)
        .padding(16)
    }
}

private struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Claude Remote").font(.headline)
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.7)
                Text("Connecting...").foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct ErrorView: View {
    let message: String
    var body: some View {
        VStack(spacing: 12) {
            Text("Claude Remote").font(.headline)
            Text(message).font(.caption).foregroundColor(.red).multilineTextAlignment(.center)
            Button("Retry") { AgentService.shared.start() }.buttonStyle(.borderedProminent)
        }
        .padding(.vertical, 8)
    }
}
