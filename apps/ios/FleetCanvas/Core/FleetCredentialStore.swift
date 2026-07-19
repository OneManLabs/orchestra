import Foundation
import Security

public actor FleetCredentialStore {
    public static let shared = FleetCredentialStore()

    private let service: String
    private let account: String
    private let accessGroup: String?

    public init(
        service: String = "com.fleetcanvas.ios.credentials",
        account: String = "primary",
        accessGroup: String? = nil
    ) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    public func save(_ connection: FleetConnection) throws {
        let data: Data
        do {
            data = try FleetCoding.encoder.encode(connection)
        } catch {
            throw FleetAPIError.encoding(String(describing: error))
        }

        var query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            query.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw keychainError(addStatus) }
            return
        }
        guard status == errSecSuccess else { throw keychainError(status) }
    }

    public func load() throws -> FleetConnection? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw keychainError(status == errSecSuccess ? errSecDecode : status)
        }
        do {
            return try FleetCoding.decoder.decode(FleetConnection.self, from: data)
        } catch {
            throw FleetAPIError.decoding("The saved Orchestra credential is invalid.")
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw keychainError(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    private func keychainError(_ status: OSStatus) -> FleetAPIError {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return .transport("Secure credential storage failed: \(message).")
    }
}
