import Foundation

public enum FleetAPIError: Error, Sendable, Equatable {
    case invalidOrigin(String)
    case missingCredentials
    case invalidRequest(String)
    case transport(String)
    case invalidResponse
    case redirectedOutsideOrigin
    case http(statusCode: Int, message: String, payload: JSONValue?)
    case encoding(String)
    case decoding(String)
    case webSocket(String)

    public var statusCode: Int? {
        guard case let .http(statusCode, _, _) = self else { return nil }
        return statusCode
    }

    public var isAuthenticationFailure: Bool {
        statusCode == 401 || statusCode == 403
    }
}

extension FleetAPIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .invalidOrigin(message), let .invalidRequest(message):
            message
        case .missingCredentials:
            "Orchestra Core credentials have not been configured."
        case let .transport(message):
            "Could not reach Orchestra Core. \(message)"
        case .invalidResponse:
            "Orchestra Core returned an invalid HTTP response."
        case .redirectedOutsideOrigin:
            "Orchestra Core attempted to redirect outside its configured origin."
        case let .http(statusCode, message, _):
            message.isEmpty ? "Orchestra Core request failed (HTTP \(statusCode))." : message
        case let .encoding(message):
            "Could not encode the Orchestra request. \(message)"
        case let .decoding(message):
            "Orchestra Core returned data the app could not read. \(message)"
        case let .webSocket(message):
            "Orchestra live connection failed. \(message)"
        }
    }
}
