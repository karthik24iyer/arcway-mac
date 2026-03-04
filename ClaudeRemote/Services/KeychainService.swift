import Security
import Foundation

enum KeychainKey: String, CaseIterable {
    case sessionToken     = "session_token"
    case deviceCredential = "device_credential"
    case userEmail        = "user_email"

    var label: String {
        switch self {
        case .sessionToken:     return "ClaudeRemote Session"
        case .deviceCredential: return "ClaudeRemote Device"
        case .userEmail:        return "ClaudeRemote Account"
        }
    }
}

private let kService = Bundle.main.bundleIdentifier ?? "com.clauderemote.app"

enum KeychainService {
    static func save(_ value: String, for key: KeychainKey) {
        let data = Data(value.utf8)
        let lookup: [CFString: Any] = [
            kSecClass:        kSecClassGenericPassword,
            kSecAttrService:  kService,
            kSecAttrAccount:  key.rawValue
        ]
        if SecItemCopyMatching(lookup as CFDictionary, nil) == errSecSuccess {
            SecItemUpdate(lookup as CFDictionary, [kSecValueData: data] as CFDictionary)
        } else {
            let item: [CFString: Any] = [
                kSecClass:                kSecClassGenericPassword,
                kSecAttrService:          kService,
                kSecAttrAccount:          key.rawValue,
                kSecAttrLabel:            key.label,
                kSecAttrAccessible:       kSecAttrAccessibleAfterFirstUnlock,
                kSecValueData:            data
            ]
            SecItemAdd(item as CFDictionary, nil)
        }
    }

    static func load(_ key: KeychainKey) -> String? {
        let query: [CFString: Any] = [
            kSecClass:        kSecClassGenericPassword,
            kSecAttrService:  kService,
            kSecAttrAccount:  key.rawValue,
            kSecReturnData:   true,
            kSecMatchLimit:   kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: KeychainKey) {
        let query: [CFString: Any] = [
            kSecClass:       kSecClassGenericPassword,
            kSecAttrService: kService,
            kSecAttrAccount: key.rawValue
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func clearAll() {
        KeychainKey.allCases.forEach { delete($0) }
    }
}
