import SwiftUI

struct LoginView: View {
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 16) {
            Text("Claude Remote").font(.headline)
            if let error = errorMessage {
                Text(error).font(.caption).foregroundColor(.red).multilineTextAlignment(.center)
            }
            Button(action: login) {
                if isLoading {
                    ProgressView().scaleEffect(0.7)
                } else {
                    Label("Login with Google", systemImage: "person.badge.key")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isLoading)
        }
        .padding(.vertical, 8)
    }

    private func login() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                try await AuthService.shared.login()
                AppState.shared.connectionState = .connecting
                AgentService.shared.start()
            } catch is CancellationError {
                // second login tap while one was in-flight — no error shown
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
