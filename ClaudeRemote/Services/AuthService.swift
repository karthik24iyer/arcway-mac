import Foundation
import AppKit
import CryptoKit

private let kGoogleClientID  = "260109272007-m8upo6vn1531vrtsiepmgc4ukthr35bd.apps.googleusercontent.com"
private let kRedirectScheme  = "com.googleusercontent.apps.260109272007-m8upo6vn1531vrtsiepmgc4ukthr35bd"
private let kRelayHttpUrl    = "https://claude-relay-server.duckdns.org"

@MainActor
class AuthService {
    static let shared = AuthService()

    private var pendingContinuation: CheckedContinuation<String, Error>?
    private var pendingVerifier: String?

    func login() async throws {
        // Cancel any in-flight login
        pendingContinuation?.resume(throwing: CancellationError())
        pendingContinuation = nil

        let verifier  = generateCodeVerifier()
        let challenge = codeChallenge(from: verifier)
        pendingVerifier = verifier

        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id",             value: kGoogleClientID),
            URLQueryItem(name: "redirect_uri",          value: "\(kRedirectScheme):/oauth2callback"),
            URLQueryItem(name: "response_type",         value: "code"),
            URLQueryItem(name: "scope",                 value: "openid email profile"),
            URLQueryItem(name: "code_challenge",        value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]

        let code: String = try await withCheckedThrowingContinuation { continuation in
            pendingContinuation = continuation
            NSWorkspace.shared.open(components.url!)
        }

        guard let verifier = pendingVerifier else { throw AuthError.tokenExchangeFailed }
        pendingVerifier = nil

        let idToken = try await exchangeCode(code, codeVerifier: verifier)
        let (sessionToken, email) = try await authenticateWithRelay(idToken: idToken)
        KeychainService.save(sessionToken, for: .sessionToken)
        KeychainService.save(email,        for: .userEmail)

        let deviceCredential = try await registerDevice(sessionToken: sessionToken)
        KeychainService.save(deviceCredential, for: .deviceCredential)
    }

    func handleCallback(url: URL) {
        guard let continuation = pendingContinuation else { return }
        pendingContinuation = nil

        let params = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.reduce(into: [String: String]()) { $0[$1.name] = $1.value ?? "" } ?? [:]

        if let error = params["error"] {
            continuation.resume(throwing: AuthError.oauthDenied(error))
        } else if let code = params["code"] {
            continuation.resume(returning: code)
        } else {
            continuation.resume(throwing: AuthError.noCode)
        }
    }

    func logout() {
        KeychainService.clearAll()
    }

    // MARK: - Private

    private func exchangeCode(_ code: String, codeVerifier: String) async throws -> String {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = [
            "code":          code,
            "client_id":     kGoogleClientID,
            "redirect_uri":  "\(kRedirectScheme):/oauth2callback",
            "code_verifier": codeVerifier,
            "grant_type":    "authorization_code",
        ].map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)" }
         .joined(separator: "&")
         .data(using: .utf8)

        let (data, _) = try await URLSession.shared.data(for: req)
        guard let json    = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let idToken = json["id_token"] as? String
        else { throw AuthError.tokenExchangeFailed }
        return idToken
    }

    private func authenticateWithRelay(idToken: String) async throws -> (String, String) {
        var req = URLRequest(url: URL(string: "\(kRelayHttpUrl)/auth/google")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["id_token": idToken])

        let (data, _) = try await URLSession.shared.data(for: req)
        guard let json         = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sessionToken = json["session_token"] as? String
        else { throw AuthError.relayAuthFailed }

        let email = decodeEmailFromJWT(sessionToken) ?? "unknown"
        return (sessionToken, email)
    }

    private func registerDevice(sessionToken: String) async throws -> String {
        var req = URLRequest(url: URL(string: "\(kRelayHttpUrl)/api/devices/register")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "name": Host.current().localizedName ?? "My Mac"
        ])

        let (data, _) = try await URLSession.shared.data(for: req)
        guard let json       = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let credential = json["device_credential"] as? String
        else { throw AuthError.registrationFailed }
        return credential
    }

    private func generateCodeVerifier() -> String {
        var buf = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, buf.count, &buf)
        return Data(buf).base64URLEncoded()
    }

    private func codeChallenge(from verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded()
    }

    private func decodeEmailFromJWT(_ token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2,
              let payload = Data(base64URLEncoded: String(parts[1])),
              let json    = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        else { return nil }
        return json["email"] as? String
    }
}

enum AuthError: LocalizedError {
    case noCode, tokenExchangeFailed, relayAuthFailed, registrationFailed, oauthDenied(String)
    var errorDescription: String? {
        switch self {
        case .noCode:                  return "No authorization code received"
        case .tokenExchangeFailed:     return "Failed to exchange authorization code"
        case .relayAuthFailed:         return "Failed to authenticate with relay server"
        case .registrationFailed:      return "Failed to register device"
        case .oauthDenied(let reason): return "Login denied: \(reason)"
        }
    }
}

private extension Data {
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    init?(base64URLEncoded string: String) {
        var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        self.init(base64Encoded: s)
    }
}
