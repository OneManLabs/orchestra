import Foundation

enum FleetEnrollmentScanResult: Equatable, Sendable {
    case connection(coreURL: String, token: String)
    case coreURLOnly(String)
    case invalid
}

func parseFleetEnrollmentQRCode(_ value: String) -> FleetEnrollmentScanResult {
    if let data = value.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        let coreURL = object["coreUrl"] as? String
            ?? object["coreURL"] as? String
            ?? object["url"] as? String
        let token = object["token"] as? String
            ?? object["accessToken"] as? String
        if let coreURL, let token, !coreURL.isEmpty, !token.isEmpty {
            return .connection(coreURL: coreURL, token: token)
        }
        return .invalid
    }

    guard let components = URLComponents(string: value),
          components.scheme == "http" || components.scheme == "https" else {
        return .invalid
    }
    var origin = components
    origin.path = ""
    origin.query = nil
    origin.fragment = nil
    guard let coreURL = origin.url?.absoluteString else { return .invalid }
    return .coreURLOnly(coreURL)
}
