import Foundation

class AgentService {
    static let shared = AgentService()
    private var process: Process?
    private var stopped = false

    func startIfCredentialed() {
        guard KeychainService.load(.deviceCredential) != nil else { return }
        DispatchQueue.main.async { AppState.shared.connectionState = .connecting }
        DispatchQueue.global().async { self.start() }
    }

    func start() {
        stopped = false
        guard let resourcePath = Bundle.main.resourcePath else { return }
        let credential = KeychainService.load(.deviceCredential) ?? ""

        var env = shellEnvironment()
        env["RELAY_URL"]         = "wss://claude-relay-server.duckdns.org"
        env["DEVICE_CREDENTIAL"] = credential

        let p = Process()
        p.executableURL       = URL(fileURLWithPath: resourcePath + "/node")
        p.arguments           = [resourcePath + "/service/src/server.js"]
        p.environment         = env
        p.currentDirectoryURL = URL(fileURLWithPath: resourcePath + "/service")

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError  = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            for line in text.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { continue }
                DispatchQueue.main.async { self?.handle(statusLine: trimmed) }
            }
        }

        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.handleTermination() }
        }

        do { try p.run() } catch {
            DispatchQueue.main.async {
                AppState.shared.connectionState = .error("Failed to start agent: \(error.localizedDescription)")
            }
            return
        }
        process = p
    }

    func stop() {
        stopped = true
        process?.terminate()
        process = nil
    }

    private func shellEnvironment() -> [String: String] {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments     = ["-l", "-i", "-c", "env"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError  = Pipe()
        try? p.run()
        p.waitUntilExit()
        let raw = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return raw.components(separatedBy: "\n").reduce(into: [:]) { d, line in
            guard let eq = line.firstIndex(of: "="),
                  line[..<eq].allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" })
            else { return }
            d[String(line[..<eq])] = String(line[line.index(after: eq)...])
        }
    }

    private func handleTermination() {
        process = nil
        guard !stopped else { return }
        AppState.shared.connectionState = .connecting
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, !self.stopped else { return }
            DispatchQueue.global().async { self.start() }
        }
    }

    private func handle(statusLine line: String) {
        switch line {
        case "STATUS:connected":
            let email = KeychainService.load(.userEmail) ?? ""
            let name  = email.split(separator: "@").first.map(String.init) ?? "there"
            AppState.shared.connectionState = .connected(userName: name.isEmpty ? "there" : name)
        case "STATUS:disconnected":
            AppState.shared.connectionState = .connecting
        default:
            break
        }
    }
}
