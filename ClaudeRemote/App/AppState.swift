import Foundation

enum ConnectionState: Equatable {
    case loggedOut
    case connecting
    case connected(userName: String)
    case error(String)
}

class AppState: ObservableObject {
    static let shared = AppState()
    @Published var connectionState: ConnectionState = .loggedOut
    private init() {}
}
