import Foundation

private func require(
    _ condition: @autoclosure () -> Bool,
    _ message: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    guard condition() else {
        fputs("FAIL \(file):\(line): \(message)\n", stderr)
        exit(1)
    }
}

private func summary(
    status: String = "healthy",
    activeJobs: Int = 0,
    degradedDevices: Int = 0,
    failedJobs: Int = 0,
    pendingApprovals: Int = 0,
    openWarnings: Int = 0,
    openCriticalAlerts: Int = 0
) -> FleetMenuSnapshot.Summary {
    FleetMenuSnapshot.Summary(
        status: status,
        totalDevices: 6,
        onlineDevices: 5,
        busyDevices: activeJobs > 0 ? 1 : 0,
        degradedDevices: degradedDevices,
        sleepingDevices: 1,
        offlineDevices: 0,
        activeJobs: activeJobs,
        queuedJobs: 0,
        failedJobs: failedJobs,
        pendingApprovals: pendingApprovals,
        openWarnings: openWarnings,
        openCriticalAlerts: openCriticalAlerts
    )
}

private func snapshot(_ summary: FleetMenuSnapshot.Summary) -> FleetMenuSnapshot {
    FleetMenuSnapshot(
        core: .init(connected: true, fleetName: "Test Fleet"),
        summary: summary
    )
}

@main
private struct FleetMenuModelTestRunner {
    static func main() throws {
        require(FleetStatusPresentation.disconnected.title == "◇", "disconnected title")
        require(FleetStatusPresentation.disconnected.severity == .disconnected, "disconnected severity")

        let healthy = FleetStatusPresentation.connected(snapshot(summary()))
        require(healthy.title == "◆", "healthy title")
        require(healthy.severity == .healthy, "healthy severity")
        require(healthy.toolTip.contains("5 online"), "healthy tooltip includes online count")

        let active = FleetStatusPresentation.connected(snapshot(summary(activeJobs: 3)))
        require(active.title == "◆ 3", "active job title")
        require(active.severity == .activity, "active severity")

        let warning = FleetStatusPresentation.connected(
            snapshot(summary(status: "degraded", degradedDevices: 1))
        )
        require(warning.title == "◆ !", "warning title")
        require(warning.severity == .warning, "warning severity")

        let critical = FleetStatusPresentation.connected(
            snapshot(summary(activeJobs: 2, pendingApprovals: 1))
        )
        require(critical.title == "◆ !", "critical title")
        require(critical.severity == .critical, "approval takes priority over activity")

        let encodedSnapshot = """
{
  "generatedAt": "2026-07-16T00:00:00.000Z",
  "core": {
    "status": "healthy",
    "connected": true,
    "fleetName": "Fleet Canvas",
    "version": "2",
    "schemaVersion": 2,
    "protocolVersion": 2,
    "url": "http://100.64.0.1:4780"
  },
  "summary": {
    "status": "healthy",
    "totalDevices": 6,
    "onlineDevices": 5,
    "busyDevices": 1,
    "degradedDevices": 0,
    "sleepingDevices": 1,
    "offlineDevices": 0,
    "activeJobs": 2,
    "queuedJobs": 0,
    "failedJobs": 0,
    "pendingApprovals": 0,
    "openWarnings": 0,
    "openCriticalAlerts": 0
  },
  "jobs": [],
  "devices": [],
  "approvals": [],
  "alerts": [],
  "recent": []
}
"""
        let decoded = try JSONDecoder().decode(
            FleetMenuSnapshot.self,
            from: Data(encodedSnapshot.utf8)
        )
        require(decoded.core.connected, "snapshot core connectivity")
        require(decoded.summary.activeJobs == 2, "snapshot active jobs")

        let validConnection = try JSONDecoder().decode(
            FleetDesktopConnection.self,
            from: Data(#"{"coreUrl":"http://100.64.0.1:4780","token":"secret"}"#.utf8)
        )
        let validatedURL = try validConnection.validatedBaseURL()
        require(validatedURL.host == "100.64.0.1", "valid connection URL")

        let invalidConnection = try JSONDecoder().decode(
            FleetDesktopConnection.self,
            from: Data(#"{"coreUrl":"file:///tmp/core","token":"secret"}"#.utf8)
        )
        do {
            _ = try invalidConnection.validatedBaseURL()
            require(false, "invalid URL scheme must be rejected")
        } catch {
            require(true, "invalid URL rejected")
        }

        print("FleetCanvasMenu model tests passed")
    }
}
