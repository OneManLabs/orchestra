import Foundation

public struct FleetCoreOrigin: Sendable, Hashable, Codable, CustomStringConvertible {
    public let url: URL

    public init(_ value: String) throws {
        guard let candidate = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw FleetAPIError.invalidOrigin("Enter a valid Orchestra Core URL.")
        }
        try self.init(url: candidate)
    }

    public init(url candidate: URL) throws {
        guard
            let scheme = candidate.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = candidate.host(percentEncoded: false),
            !host.isEmpty
        else {
            throw FleetAPIError.invalidOrigin("Orchestra Core must use an absolute HTTP or HTTPS URL.")
        }
        guard candidate.user == nil, candidate.password == nil else {
            throw FleetAPIError.invalidOrigin("Orchestra Core URLs cannot contain credentials.")
        }
        guard candidate.query == nil, candidate.fragment == nil else {
            throw FleetAPIError.invalidOrigin("Orchestra Core URLs cannot contain a query or fragment.")
        }
        let path = candidate.path(percentEncoded: false)
        guard path.isEmpty || path == "/" else {
            throw FleetAPIError.invalidOrigin("Enter the Orchestra Core origin without an API path.")
        }

        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = candidate.port
        guard let normalized = components.url else {
            throw FleetAPIError.invalidOrigin("Orchestra Core URL could not be normalized.")
        }
        url = normalized
    }

    public var description: String { url.absoluteString }

    public var webSocketURL: URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/client"
        return components.url!
    }

    public func appending(path: String) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else {
            throw FleetAPIError.invalidRequest("Orchestra API paths must begin with exactly one slash.")
        }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw FleetAPIError.invalidOrigin("Orchestra Core URL could not be read.")
        }
        guard let relative = URLComponents(string: path), relative.scheme == nil, relative.host == nil else {
            throw FleetAPIError.invalidRequest("Orchestra API paths cannot change the configured origin.")
        }
        components.percentEncodedPath = relative.percentEncodedPath
        components.percentEncodedQuery = relative.percentEncodedQuery
        components.fragment = nil
        guard let result = components.url, contains(result) else {
            throw FleetAPIError.invalidRequest("Orchestra API request escaped the configured origin.")
        }
        return result
    }

    public func contains(_ candidate: URL) -> Bool {
        guard
            candidate.scheme?.lowercased() == url.scheme?.lowercased(),
            candidate.host(percentEncoded: false)?.lowercased() == url.host(percentEncoded: false)?.lowercased()
        else { return false }
        return effectivePort(candidate) == effectivePort(url)
    }

    private func effectivePort(_ value: URL) -> Int? {
        if let port = value.port { return port }
        switch value.scheme?.lowercased() {
        case "http", "ws": return 80
        case "https", "wss": return 443
        default: return nil
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(try container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(url.absoluteString)
    }
}

public struct FleetConnection: Sendable, Hashable, Codable {
    public let origin: FleetCoreOrigin
    public let token: String
    public let savedAt: Date

    public init(origin: FleetCoreOrigin, token: String, savedAt: Date = .now) throws {
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedToken.isEmpty else {
            throw FleetAPIError.missingCredentials
        }
        guard !normalizedToken.contains(where: \.isNewline) else {
            throw FleetAPIError.invalidRequest("Orchestra credentials cannot contain line breaks.")
        }
        self.origin = origin
        self.token = normalizedToken
        self.savedAt = savedAt
    }

    public init(coreURL: String, token: String, savedAt: Date = .now) throws {
        try self.init(origin: FleetCoreOrigin(coreURL), token: token, savedAt: savedAt)
    }
}

internal func fleetEncodedPathComponent(_ value: String) throws -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#%")
    guard !value.isEmpty, let result = value.addingPercentEncoding(withAllowedCharacters: allowed) else {
        throw FleetAPIError.invalidRequest("Orchestra resource ID is invalid.")
    }
    return result
}
