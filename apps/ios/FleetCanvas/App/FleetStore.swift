import Foundation
import LocalAuthentication
import Observation
import UIKit

enum FleetConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

enum ApprovalDecision: String, Sendable {
    case accept
    case acceptForSession
    case decline
}

enum FleetStoreErrorOrigin: Equatable, Sendable {
    case connection
    case refresh
    case action
}

@MainActor
@Observable
final class FleetStore {
    private let client: FleetAPIClient
    private let credentialStore: FleetCredentialStore
    private var liveTask: Task<Void, Never>?
    private var scheduledRefreshTask: Task<Void, Never>?
    let codexIdentity: CodexClientIdentity

    private(set) var connectionState: FleetConnectionState = .disconnected
    private(set) var credentials: FleetConnection?
    private(set) var menuSnapshot: FleetMenuSnapshot?
    private(set) var snapshot: FleetSnapshot?
    private(set) var codexSessions: [CodexSession] = []
    private(set) var systemConversationState: FleetSystemConversation?
    private(set) var systemConversationHistory: [FleetSystemConversation] = []
    private(set) var activityEvents: [FleetActivityEvent] = []
    private(set) var notifications: [FleetNotification] = []
    private(set) var pipelineRuns: [PipelineRun] = []
    private(set) var isRefreshing = false
    private(set) var liveConnectionIssue: String?
    var lastError: String?
    private var lastErrorOrigin: FleetStoreErrorOrigin?

    init(
        client: FleetAPIClient = .shared,
        credentialStore: FleetCredentialStore = .shared
    ) {
        self.client = client
        self.credentialStore = credentialStore
        let defaults = UserDefaults.standard
        let identityKey = "fleet.codex.client-id"
        let clientID = defaults.string(forKey: identityKey) ?? UUID().uuidString.lowercased()
        defaults.set(clientID, forKey: identityKey)
        self.codexIdentity = CodexClientIdentity(
            clientId: clientID,
            name: defaults.string(forKey: "fleet.codex.participant-name") ?? "Nick",
            deviceName: UIDevice.current.name
        )
    }

    var isConfigured: Bool { credentials != nil }
    var devices: [FleetDevice] { snapshot?.devices ?? [] }
    var projects: [FleetProject] { snapshot?.projects ?? [] }
    var jobs: [FleetJob] { snapshot?.jobs ?? [] }
    var sessions: [CodexSession] { codexSessions }
    var systemConversation: FleetSystemConversation? { systemConversationState }
    var systemConversations: [FleetSystemConversation] { systemConversationHistory }
    var activity: [FleetActivityEvent] { activityEvents }
    var alerts: [FleetAlert] { snapshot?.v2.alerts ?? [] }
    var approvals: [FleetMenuApproval] { menuSnapshot?.approvals ?? [] }
    var orderedDevices: [FleetDevice] {
        devices.sorted {
            let leftRank = fleetDeviceStatusRank($0.status)
            let rightRank = fleetDeviceStatusRank($1.status)
            if leftRank == rightRank {
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
            return leftRank < rightRank
        }
    }
    var reachableDevices: [FleetDevice] {
        orderedDevices.filter { $0.status != .offline }
    }
    var orderedJobs: [FleetJob] {
        jobs.sorted { $0.createdAt > $1.createdAt }
    }
    var activeJobs: [FleetJob] {
        orderedJobs.filter(\.status.isActive)
    }
    var currentCodexSessions: [CodexSession] {
        let activeSessionIDs = Set(devices.flatMap(\.activeSessionIds))
        return sessions
            .filter {
                codexSessionIsCurrent(
                    sessionID: $0.id,
                    status: $0.status,
                    activeSessionIDs: activeSessionIDs
                )
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    var activeCodexSessions: [CodexSession] { currentCodexSessions }
    var recentCodexSessions: [CodexSession] {
        let currentIDs = Set(currentCodexSessions.map(\.id))
        return sessions
            .filter { !currentIDs.contains($0.id) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func start() async {
        if let debugConnection = try? debugEnvironmentConnection() {
            do {
                try await activate(debugConnection, persist: true)
                return
            } catch {
                presentError(error.localizedDescription, origin: .connection)
            }
        }

        do {
            guard let saved = try await credentialStore.load() else {
                connectionState = .disconnected
                return
            }
            try await activate(saved, persist: false)
        } catch {
            connectionState = .disconnected
            presentError(error.localizedDescription, origin: .connection)
        }
    }

    @discardableResult
    func connect(coreURL: String, token: String) async -> Bool {
        do {
            let connection = try FleetConnection(coreURL: coreURL, token: token)
            try await activate(connection, persist: true)
            return true
        } catch {
            presentError(error.localizedDescription, origin: .connection)
            return false
        }
    }

    @discardableResult
    func connect(_ connection: FleetConnection) async -> Bool {
        do {
            try await activate(connection, persist: true)
            return true
        } catch {
            presentError(error.localizedDescription, origin: .connection)
            return false
        }
    }

    func disconnect() {
        liveTask?.cancel()
        scheduledRefreshTask?.cancel()
        liveTask = nil
        scheduledRefreshTask = nil
        credentials = nil
        snapshot = nil
        codexSessions = []
        systemConversationState = nil
        systemConversationHistory = []
        activityEvents = []
        menuSnapshot = nil
        notifications = []
        pipelineRuns = []
        connectionState = .disconnected
        liveConnectionIssue = nil
        clearError()
        Task {
            await client.clearConnection()
            try? await credentialStore.delete()
        }
    }

    func refresh() async {
        await refresh(reportFailures: true)
    }

    private func refresh(reportFailures: Bool) async {
        guard credentials != nil, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            apply(try await loadFleetState())
            connectionState = .connected
            liveConnectionIssue = nil
            if reportFailures {
                clearError()
            } else {
                clearRecoveredBackgroundError()
            }
        } catch {
            let authenticationFailure = (error as? FleetAPIError)?.isAuthenticationFailure == true
            if authenticationFailure {
                connectionState = .disconnected
                presentError(error.localizedDescription, origin: .connection)
            } else if reportFailures {
                presentError(error.localizedDescription, origin: .refresh)
            } else {
                liveConnectionIssue = error.localizedDescription
            }
        }
    }

    func appDidBecomeActive() async {
        guard credentials != nil else { return }
        await refresh(reportFailures: false)
        startLiveStream()
    }

    func power(deviceID: String, action: FleetPowerAction) async {
        guard await authorizeSensitiveAction(
            reason: "\(action.displayName) \(deviceName(deviceID)) using Orchestra Canvas"
        ) else { return }
        await performAndRefresh {
            _ = try await self.client.power(deviceIDs: [deviceID], action: action)
        }
    }

    func cancelJob(_ id: String) async {
        await performAndRefresh { _ = try await self.client.cancelJob(id: id) }
    }

    func retryJob(_ id: String) async {
        await performAndRefresh { _ = try await self.client.startJob(id: id) }
    }

    func createJob(_ request: CreateFleetJobRequest) async {
        await performAndRefresh { _ = try await self.client.createJob(request) }
    }

    func acknowledgeAlert(_ id: String) async {
        await performAndRefresh { _ = try await self.client.acknowledgeAlert(id: id) }
    }

    func resolveAlert(_ id: String) async {
        await performAndRefresh { _ = try await self.client.resolveAlert(id: id) }
    }

    @discardableResult
    func respond(to approval: FleetMenuApproval, decision: ApprovalDecision) async -> Bool {
        guard await authorizeSensitiveAction(reason: "Review this Orchestra approval") else { return false }
        let succeeded = await performAndRefresh {
            switch approval {
            case let .codex(item):
                _ = try await self.client.respondToApproval(
                    sessionID: item.sessionId,
                    requestID: item.requestId,
                    result: .object(["decision": .string(decision.rawValue)]),
                    client: self.codexIdentity
                )
            case let .pipeline(item):
                if decision == .decline {
                    _ = try await self.client.rejectPipelineNode(
                        runID: item.pipelineRunId,
                        nodeRunID: item.nodeRunId
                    )
                } else {
                    _ = try await self.client.approvePipelineNode(
                        runID: item.pipelineRunId,
                        nodeRunID: item.nodeRunId
                    )
                }
            }
        }
        if succeeded {
            FleetLocalFeedback.approvalDecision(decision)
        }
        return succeeded
    }

    func createSession(_ request: CreateCodexSessionRequest) async -> CodexSession? {
        if request.permissionMode == .dangerFullAccess {
            guard await authorizeSensitiveAction(reason: "Start a full-access Codex session") else {
                return nil
            }
        }
        return await performAndRefreshReturning {
            try await self.client.createSession(request)
        }
    }

    func deviceWorkspace(
        deviceID: String,
        path: String,
        cursor: String? = nil
    ) async throws -> FleetWorkspacePage {
        try await client.deviceWorkspace(deviceID: deviceID, path: path, cursor: cursor)
    }

    func createDeviceWorkspaceDirectory(
        deviceID: String,
        path: String
    ) async throws -> FleetWorkspaceDirectoryResult {
        try await client.createDeviceWorkspaceDirectory(deviceID: deviceID, path: path)
    }

    @discardableResult
    func updateSessionPermission(sessionID: String, permissionMode: FleetPermissionMode) async -> Bool {
        if permissionMode == .dangerFullAccess {
            guard await authorizeSensitiveAction(reason: "Give this Codex session full access") else {
                return false
            }
        }
        do {
            let updated = try await client.updateSessionPermission(
                id: sessionID,
                permissionMode: permissionMode,
                client: codexIdentity
            )
            upsertCodexSession(updated)
            clearError()
            return true
        } catch is CancellationError {
            return false
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    @discardableResult
    func sendMessage(sessionID: String, text: String) async -> Bool {
        do {
            let updated = try await client.sendMessage(
                sessionID: sessionID,
                text: text,
                client: codexIdentity
            )
            upsertCodexSession(updated)
            clearError()
            return true
        } catch is CancellationError {
            return false
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    @discardableResult
    func sendSystemMessage(_ text: String, mode: String = "chat") async -> Bool {
        do {
            let updated = try await client.sendSystemMessage(text: text, mode: mode, client: codexIdentity)
            upsertSystemConversation(updated)
            clearError()
            return true
        } catch is CancellationError {
            return false
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    func executeConductorPlan(_ id: String) async {
        await performAndRefresh {
            _ = try await self.client.executeConductorPlan(id: id, client: self.codexIdentity)
        }
    }

    func cancelConductorPlan(_ id: String) async {
        await performAndRefresh {
            _ = try await self.client.cancelConductorPlan(id: id, client: self.codexIdentity)
        }
    }

    @discardableResult
    func newSystemConversation() async -> Bool {
        do {
            let updated = try await client.newSystemConversation(client: codexIdentity)
            upsertSystemConversation(updated)
            clearError()
            return true
        } catch is CancellationError {
            return false
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    @discardableResult
    func clearSystemConversation() async -> Bool {
        do {
            let updated = try await client.clearSystemConversation(client: codexIdentity)
            upsertSystemConversation(updated)
            clearError()
            return true
        } catch is CancellationError {
            return false
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    @discardableResult
    func confirmSystemPowerAction(_ action: FleetSystemPendingAction) async -> Bool {
        do {
            _ = try await client.confirmSystemPowerAction(
                id: action.id,
                action: action.action,
                deviceIds: action.deviceIds,
                client: codexIdentity
            )
            await refresh(reportFailures: false)
            clearError()
            return true
        } catch is CancellationError {
            return false
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    func resumeSession(_ id: String) async {
        await performAndRefresh { _ = try await self.client.resumeSession(id: id) }
    }

    func forkSession(_ id: String, from event: CodexEvent) async -> CodexSession? {
        guard let source = sessions.first(where: { $0.id == id }) else { return nil }
        return await performAndRefreshReturning {
            try await self.client.forkSession(
                id: id,
                deviceID: source.deviceId,
                title: "\(source.title) (branch)",
                lastTurnID: codexEventTurnID(event)
            )
        }
    }

    func interruptSession(_ id: String) async {
        await performAndRefresh {
            _ = try await self.client.interruptSession(id: id, client: self.codexIdentity)
        }
    }

    func stopSession(_ id: String) async {
        await performAndRefresh { _ = try await self.client.stopSession(id: id) }
    }

    func startProjectPreview(
        _ projectID: String,
        visibility: ProjectPreviewVisibility = .tailnet
    ) async {
        await performAndRefresh {
            _ = try await self.client.startProjectPreview(
                projectID: projectID,
                visibility: visibility
            )
        }
    }

    func stopProjectPreview(_ projectID: String) async {
        await performAndRefresh {
            _ = try await self.client.stopProjectPreview(projectID: projectID)
        }
    }

    func touchProjectPreview(_ projectID: String) async {
        // Activity touches only extend an already-running preview. They are
        // best-effort and must not replace an actionable user-facing error.
        _ = try? await client.touchProjectPreview(projectID: projectID)
    }

    func updateCodexPresence(sessionID: String, typing: Bool) async {
        do {
            _ = try await client.updateCodexPresence(
                sessionID: sessionID,
                client: codexIdentity,
                typing: typing
            )
        } catch is CancellationError {
            // Presence is best-effort and must never surface as a chat error
            // when a debounced update is superseded by the next keystroke.
        } catch {
            // Presence is ephemeral. A failed heartbeat must not replace an
            // actionable Orchestra or Codex error, nor block the composer.
        }
    }

    func requestCodexControl(sessionID: String) async {
        await performAndRefresh {
            _ = try await self.client.requestCodexControl(
                sessionID: sessionID,
                client: self.codexIdentity
            )
        }
    }

    func markNotificationRead(_ id: String) async {
        await performAndRefresh { _ = try await self.client.markNotificationRead(id: id) }
    }

    private func activate(_ connection: FleetConnection, persist: Bool) async throws {
        let checkpoint = FleetConnectionRollbackCheckpoint(
            connection: credentials,
            state: connectionState
        )

        liveTask?.cancel()
        scheduledRefreshTask?.cancel()
        liveTask = nil
        scheduledRefreshTask = nil
        connectionState = .connecting
        liveConnectionIssue = nil
        clearError()
        await client.configure(connection)

        do {
            let health = try await client.health()
            guard health.ok else {
                throw FleetAPIError.invalidResponse
            }
            let loadedState = try await loadFleetState()
            if persist {
                try await credentialStore.save(connection)
            }

            credentials = connection
            apply(loadedState)
            connectionState = .connected
            clearError()
            startLiveStream()
        } catch {
            await restoreFleetClientConnection(checkpoint.connection, client: client)
            credentials = checkpoint.connection
            connectionState = checkpoint.restoredState
            if checkpoint.shouldRestartLiveStream {
                startLiveStream()
            }
            throw error
        }
    }

    private func startLiveStream() {
        liveTask?.cancel()
        liveTask = Task { [weak self] in
            guard let self else { return }
            do {
                let stream = try await client.liveEventStream()
                for try await update in stream.events() {
                    guard !Task.isCancelled else { return }
                    await handle(update)
                }
            } catch is CancellationError {
                return
            } catch {
                connectionState = .disconnected
                liveConnectionIssue = error.localizedDescription
            }
        }
    }

    func handle(_ update: FleetLiveStreamUpdate) async {
        switch update {
        case .connected:
            connectionState = .connected
            liveConnectionIssue = nil
            clearRecoveredBackgroundError()
        case let .reconnecting(attempt, _):
            connectionState = .reconnecting(attempt: attempt)
        case let .disconnected(reason):
            liveConnectionIssue = reason
            connectionState = .reconnecting(attempt: 1)
        case let .event(event):
            if event.type == "snapshot", let decoded = try? event.payload.decode(FleetSnapshot.self) {
                let previousSessions = codexSessions
                snapshot = decoded
                codexSessions = mergeLiveCodexSessions(current: previousSessions, incoming: decoded.sessions)
                systemConversationState = decoded.systemConversation
                systemConversationHistory = decoded.systemConversations ?? [decoded.systemConversation]
                activityEvents = decoded.activity
                scheduleRefresh()
                return
            }
            if event.type == "session.updated",
               let updated = try? event.payload.decode(CodexSession.self) {
                let previous = codexSessions.first { $0.id == updated.id }
                upsertCodexSession(updated)
                if codexSessionUpdateNeedsFleetRefresh(previous: previous, updated: updated) {
                    scheduleRefresh()
                }
                return
            }
            if event.type == "session.event.updated",
               let updated = try? event.payload.decode(CodexSessionEventUpdate.self),
               let index = codexSessions.firstIndex(where: { $0.id == updated.sessionId }) {
                codexSessions[index] = codexSessions[index].applying(updated)
                return
            }
            if event.type == "system.updated",
               let updated = try? event.payload.decode(FleetSystemConversation.self) {
                upsertSystemConversation(updated)
                return
            }
            if event.type == "activity.created",
               let updated = try? event.payload.decode(FleetActivityEvent.self) {
                upsertActivityEvent(updated)
                return
            }
            scheduleRefresh()
        }
    }

    private func upsertCodexSession(_ updated: CodexSession) {
        if let index = codexSessions.firstIndex(where: { $0.id == updated.id }) {
            codexSessions[index] = codexSessions[index].mergingLiveProjection(updated)
        } else {
            codexSessions.insert(updated, at: 0)
        }
    }

    private func mergeLiveCodexSessions(current: [CodexSession], incoming: [CodexSession]) -> [CodexSession] {
        let existing = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
        let incomingIDs = Set(incoming.map(\.id))
        return incoming.map { session in
            existing[session.id]?.mergingLiveProjection(session) ?? session
        } + current.filter { !incomingIDs.contains($0.id) }
    }

    private func upsertSystemConversation(_ updated: FleetSystemConversation) {
        systemConversationState = updated
        if let index = systemConversationHistory.firstIndex(where: { $0.id == updated.id }) {
            systemConversationHistory[index] = updated
        } else {
            systemConversationHistory.insert(updated, at: 0)
        }
    }

    private func upsertActivityEvent(_ updated: FleetActivityEvent) {
        activityEvents.removeAll { $0.id == updated.id }
        activityEvents.insert(updated, at: 0)
        if activityEvents.count > 250 {
            activityEvents.removeLast(activityEvents.count - 250)
        }
    }

    private func scheduleRefresh() {
        guard shouldScheduleFleetRefresh(hasScheduledRefresh: scheduledRefreshTask != nil) else {
            return
        }
        scheduledRefreshTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(180))
            } catch {
                self?.scheduledRefreshTask = nil
                return
            }
            guard !Task.isCancelled else {
                self?.scheduledRefreshTask = nil
                return
            }
            await self?.refresh(reportFailures: false)
            self?.scheduledRefreshTask = nil
        }
    }

    @discardableResult
    private func performAndRefresh(_ operation: @escaping @Sendable () async throws -> Void) async -> Bool {
        do {
            try await operation()
            await refresh(reportFailures: false)
            clearError()
            return true
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return false
        }
    }

    private func performAndRefreshReturning<T: Sendable>(
        _ operation: @escaping @Sendable () async throws -> T
    ) async -> T? {
        do {
            let result = try await operation()
            await refresh(reportFailures: false)
            clearError()
            return result
        } catch {
            presentError(error.localizedDescription, origin: .action)
            return nil
        }
    }

    private func presentError(_ message: String, origin: FleetStoreErrorOrigin) {
        lastError = message
        lastErrorOrigin = origin
    }

    private func clearError() {
        lastError = nil
        lastErrorOrigin = nil
    }

    private func clearRecoveredBackgroundError() {
        guard shouldClearFleetErrorAfterBackgroundRecovery(lastErrorOrigin) else {
            return
        }
        clearError()
    }

    private func authorizeSensitiveAction(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            presentError(
                sensitiveActionAuthenticationUnavailableMessage(error),
                origin: .action
            )
            return false
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            presentError("Authentication was cancelled.", origin: .action)
            return false
        }
    }

    private func loadFleetState() async throws -> FleetLoadedState {
        async let full = client.snapshot()
        async let sessions = client.sessions()
        async let menu = client.menuSnapshot()
        async let currentNotifications = client.notifications()
        async let runs = client.pipelineRuns()
        let (snapshot, codexSessions, menuSnapshot, notifications, pipelineRuns) =
            try await (full, sessions, menu, currentNotifications, runs)
        return FleetLoadedState(
            snapshot: snapshot,
            codexSessions: codexSessions,
            menuSnapshot: menuSnapshot,
            notifications: notifications,
            pipelineRuns: pipelineRuns
        )
    }

    private func apply(_ state: FleetLoadedState) {
        snapshot = state.snapshot
        // A slower REST refresh may finish after a live Codex event. Preserve
        // the newest per-session metadata and union its streamed events.
        codexSessions = mergeLiveCodexSessions(current: codexSessions, incoming: state.codexSessions)
        systemConversationState = state.snapshot.systemConversation
        systemConversationHistory = state.snapshot.systemConversations ?? [state.snapshot.systemConversation]
        activityEvents = state.snapshot.activity
        menuSnapshot = state.menuSnapshot
        notifications = state.notifications
        pipelineRuns = state.pipelineRuns
    }

    private func deviceName(_ id: String) -> String {
        devices.first(where: { $0.id == id })?.name ?? "device"
    }

    private func debugEnvironmentConnection() throws -> FleetConnection? {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard
            let coreURL = environment["FLEET_CORE_URL"],
            let token = environment["FLEET_TOKEN"],
            !coreURL.isEmpty,
            !token.isEmpty
        else { return nil }
        return try FleetConnection(coreURL: coreURL, token: token)
        #else
        return nil
        #endif
    }
}

private struct FleetLoadedState: Sendable {
    let snapshot: FleetSnapshot
    let codexSessions: [CodexSession]
    let menuSnapshot: FleetMenuSnapshot
    let notifications: [FleetNotification]
    let pipelineRuns: [PipelineRun]
}

struct FleetConnectionRollbackCheckpoint: Sendable {
    let connection: FleetConnection?
    let state: FleetConnectionState

    var restoredState: FleetConnectionState {
        connection == nil ? .disconnected : state
    }

    var shouldRestartLiveStream: Bool {
        connection != nil && restoredState != .disconnected
    }
}

func restoreFleetClientConnection(
    _ connection: FleetConnection?,
    client: FleetAPIClient
) async {
    if let connection {
        await client.configure(connection)
    } else {
        await client.clearConnection()
    }
}

func sensitiveActionAuthenticationUnavailableMessage(_ error: NSError?) -> String {
    if error?.domain == LAError.errorDomain,
       error?.code == LAError.passcodeNotSet.rawValue {
        return "Sensitive Orchestra actions are locked. Set an iPhone passcode, then try again."
    }
    return "Sensitive Orchestra actions are locked because device-owner authentication is unavailable."
}

func shouldClearFleetErrorAfterBackgroundRecovery(
    _ origin: FleetStoreErrorOrigin?
) -> Bool {
    origin == .connection || origin == .refresh
}

func codexSessionUpdateNeedsFleetRefresh(
    previous: CodexSession?,
    updated: CodexSession
) -> Bool {
    guard let previous else { return true }
    return previous.pendingApprovals != updated.pendingApprovals
}

func fleetDeviceStatusRank(_ status: FleetDeviceStatus) -> Int {
    switch status {
    case .busy: 0
    case .degraded: 1
    case .online: 2
    case .offline: 3
    }
}

func shouldScheduleFleetRefresh(hasScheduledRefresh: Bool) -> Bool {
    !hasScheduledRefresh
}

func fleetMenuHealthIsNominal(_ health: FleetMenuHealth) -> Bool {
    health == .healthy
}

func codexSessionIsCurrent(
    sessionID: String,
    status: CodexSessionStatus,
    activeSessionIDs: Set<String>
) -> Bool {
    switch status {
    case .starting, .ready, .thinking, .awaitingApproval:
        return true
    case .completed:
        // A completed turn remains a current conversation only while Orchestra
        // Core's device registry still owns that session. Other completed
        // sessions stay fully accessible in Recent.
        return activeSessionIDs.contains(sessionID)
    case .error, .stopped:
        return false
    }
}

extension FleetPowerAction {
    var displayName: String {
        switch self {
        case .wake: "Wake"
        case .sleep: "Sleep"
        case .restart: "Restart"
        case .shutdown: "Shut down"
        case .lock: "Lock"
        case .logout: "Log out"
        }
    }
}
