import Foundation

struct FleetDesktopConnection: Decodable {
    let coreUrl: String
    let token: String

    func validatedBaseURL() throws -> URL {
        let trimmedURL = coreUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else {
            throw FleetMenuError.invalidConnection
        }
        guard
            let url = URL(string: trimmedURL),
            let scheme = url.scheme?.lowercased(),
            (scheme == "http" || scheme == "https"),
            url.host != nil
        else {
            throw FleetMenuError.invalidConnection
        }
        return url
    }
}

struct FleetMenuSnapshot: Decodable {
    struct Core: Decodable {
        let connected: Bool
        let fleetName: String
    }

    struct Summary: Decodable {
        let status: String
        let totalDevices: Int
        let onlineDevices: Int
        let busyDevices: Int
        let degradedDevices: Int
        let sleepingDevices: Int
        let offlineDevices: Int
        let activeJobs: Int
        let queuedJobs: Int
        let failedJobs: Int
        let pendingApprovals: Int
        let openWarnings: Int
        let openCriticalAlerts: Int
    }

    let core: Core
    let summary: Summary
}

enum FleetMenuError: LocalizedError {
    case invalidConnection
    case invalidResponse
    case responseTooLarge
    case requestFailed(Int)

    var errorDescription: String? {
        switch self {
        case .invalidConnection:
            return "Orchestra Core connection is not configured"
        case .invalidResponse:
            return "Orchestra Core returned an invalid response"
        case .responseTooLarge:
            return "Orchestra Core returned an oversized response"
        case .requestFailed(let status):
            return "Orchestra Core request failed (\(status))"
        }
    }
}

enum FleetMenuSeverity: Equatable {
    case disconnected
    case healthy
    case activity
    case warning
    case critical
}

struct FleetStatusPresentation: Equatable {
    let title: String
    let severity: FleetMenuSeverity
    let toolTip: String

    static let disconnected = FleetStatusPresentation(
        title: "◇",
        severity: .disconnected,
        toolTip: "Orchestra Canvas — Core disconnected"
    )

    static func connected(_ snapshot: FleetMenuSnapshot) -> FleetStatusPresentation {
        let summary = snapshot.summary
        let fleetName = snapshot.core.fleetName.isEmpty ? "Orchestra Canvas" : snapshot.core.fleetName
        let activeJobs = max(0, summary.activeJobs)
        let onlineDevices = max(0, summary.onlineDevices)

        let severity: FleetMenuSeverity
        let title: String
        let stateText: String

        if summary.openCriticalAlerts > 0 || summary.pendingApprovals > 0 {
            severity = .critical
            title = "◆ !"
            stateText = "attention required"
        } else if summary.status != "healthy"
                    || summary.openWarnings > 0
                    || summary.degradedDevices > 0
                    || summary.failedJobs > 0 {
            severity = .warning
            title = "◆ !"
            stateText = "fleet degraded"
        } else if activeJobs > 0 {
            severity = .activity
            title = "◆ \(activeJobs)"
            stateText = "\(activeJobs) active job\(activeJobs == 1 ? "" : "s")"
        } else {
            severity = .healthy
            title = "◆"
            stateText = "healthy"
        }

        return FleetStatusPresentation(
            title: title,
            severity: severity,
            toolTip: "\(fleetName) — \(stateText) • \(onlineDevices) online"
        )
    }
}
