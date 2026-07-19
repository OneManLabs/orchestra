import Foundation

public enum FleetDeviceRole: String, Codable, Sendable, CaseIterable {
    case core, gpu, worker, gateway, storage, workstation, phone, unknown
}

public enum FleetDeviceStatus: String, Codable, Sendable, CaseIterable {
    case online, busy, degraded, offline
}

public enum FleetMenuDeviceStatus: String, Codable, Sendable, CaseIterable {
    case online, busy, degraded, sleeping, offline
}

public enum FleetJobStatus: String, Codable, Sendable, CaseIterable {
    case queued, dispatching, running
    case awaitingApproval = "awaiting-approval"
    case completed, failed, cancelled
}

public enum FleetJobKind: String, Codable, Sendable, CaseIterable {
    case codex, shell
}

public enum FleetPermissionMode: String, Codable, Sendable, CaseIterable {
    case readOnly = "read-only"
    case workspaceWrite = "workspace-write"
    case dangerFullAccess = "danger-full-access"
}

public enum FleetApprovalPolicy: String, Codable, Sendable, CaseIterable {
    case untrusted
    case onRequest = "on-request"
    case never
}

public enum CodexSessionStatus: String, Codable, Sendable, CaseIterable {
    case starting, ready, thinking
    case awaitingApproval = "awaiting-approval"
    case completed, error, stopped
}

public enum FleetPowerAction: String, Codable, Sendable, CaseIterable {
    case wake, sleep, restart, shutdown, lock, logout
}

public enum FleetAlertSeverity: String, Codable, Sendable, CaseIterable {
    case info, warning, critical
}

public enum FleetAlertStatus: String, Codable, Sendable, CaseIterable {
    case open, acknowledged, resolved
}

public enum FleetNotificationSeverity: String, Codable, Sendable, CaseIterable {
    case info, success, warning, critical
}

public enum FleetNotificationStatus: String, Codable, Sendable, CaseIterable {
    case pending, sent, failed, read
}

public enum PipelineExecutionState: String, Codable, Sendable, CaseIterable {
    case pending, queued, running
    case awaitingApproval = "awaiting-approval"
    case succeeded, failed, cancelled, skipped
}

public enum PipelineTriggerType: String, Codable, Sendable, CaseIterable {
    case manual, schedule, webhook
    case gitPush = "git-push"
    case file, job, device, metric, external
}

public struct FleetPosition: Codable, Sendable, Hashable {
    public let x: Double
    public let y: Double
}

public struct FleetCPU: Codable, Sendable, Hashable {
    public let model: String
    public let cores: Int
    public let usagePercent: Double
    public let temperatureCelsius: Double?
}

public struct FleetMemory: Codable, Sendable, Hashable {
    public let totalBytes: Double
    public let usedBytes: Double
    public let usagePercent: Double
}

public struct FleetStorageMetric: Codable, Sendable, Hashable {
    public let totalBytes: Double
    public let usedBytes: Double
    public let usagePercent: Double
    public let mount: String
}

public struct FleetGPU: Codable, Sendable, Hashable {
    public let vendor: String
    public let model: String
    public let vramTotalBytes: Double?
    public let vramUsedBytes: Double?
    public let usagePercent: Double?
    public let temperatureCelsius: Double?
    public let fanSpeedPercent: Double?
    public let powerDrawWatts: Double?
    public let powerLimitWatts: Double?
}

public struct FleetNetworkMetric: Codable, Sendable, Hashable {
    public let rxBytesPerSecond: Double
    public let txBytesPerSecond: Double
    public let tailscaleIp: String?
    public let tailscaleDnsName: String?
}

public struct FleetBatteryMetric: Codable, Sendable, Hashable {
    public let state: String
    public let percent: Double
    public let isCharging: Bool
    public let acConnected: Bool
    public let timeRemainingMinutes: Double?
    public let cycleCount: Int?
}

public struct FleetFanMetric: Codable, Sendable, Hashable {
    public let label: String
    public let speedPercent: Double?
    public let speedRpm: Double?
}

public struct FleetServiceHealth: Codable, Sendable, Hashable {
    public let total: Int
    public let running: Int
    public let stopped: Int
}

public struct FleetDeviceMetrics: Codable, Sendable, Hashable {
    public let cpu: FleetCPU
    public let memory: FleetMemory
    public let storage: [FleetStorageMetric]
    public let gpus: [FleetGPU]
    public let network: FleetNetworkMetric
    public let battery: FleetBatteryMetric?
    public let powerDrawWatts: Double?
    public let powerDrawSource: String?
    public let fans: [FleetFanMetric]?
    public let processCount: Int?
    public let runningProcessCount: Int?
    public let serviceHealth: FleetServiceHealth?
    public let uptimeSeconds: Double
    public let sampledAt: Date
}

public struct FleetDeviceCapabilities: Codable, Sendable, Hashable {
    public let codex: Bool
    public let git: Bool
    public let docker: Bool
    public let tailscale: Bool
    public let cuda: Bool
    public let mlx: Bool
    public let node: Bool
    public let wakeOnLan: Bool
    public let shell: String
    public let labels: [String]
}

public enum FleetDevicePresenceLayerState: String, Codable, Sendable, Hashable {
    case reachable, unreachable, stale, unknown
    case notConfigured = "not-configured"
}

public enum FleetDevicePresenceSummary: String, Codable, Sendable, Hashable {
    case operational, degraded, unknown
    case agentOffline = "agent-offline"
    case hostUnreachable = "host-unreachable"
}

public struct FleetDevicePresenceLayer: Codable, Sendable, Hashable {
    public let state: FleetDevicePresenceLayerState
    public let checkedAt: Date
    public let detail: String
}

public struct FleetDevicePresence: Codable, Sendable, Hashable {
    public let summary: FleetDevicePresenceSummary
    public let label: String
    public let detail: String
    public let updatedAt: Date
    public let agent: FleetDevicePresenceLayer
    public let tailscale: FleetDevicePresenceLayer
    public let lan: FleetDevicePresenceLayer
    public let services: FleetDevicePresenceLayer
}

public struct FleetDevice: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let hostname: String
    public let role: FleetDeviceRole
    public let status: FleetDeviceStatus
    public let platform: String
    public let arch: String
    public let osName: String
    public let osVersion: String
    public let agentVersion: String
    public let capabilities: FleetDeviceCapabilities
    public let metrics: FleetDeviceMetrics
    public let projectRoots: [String]
    public let position: FleetPosition
    public let lastSeenAt: Date
    public let connectedAt: Date
    public let activeJobIds: [String]
    public let activeSessionIds: [String]
    public let presence: FleetDevicePresence?
}

public struct FleetProjectPath: Codable, Sendable, Hashable {
    public let deviceId: String
    public let path: String
}

public struct FleetProjectCommands: Codable, Sendable, Hashable {
    public let build: String?
    public let test: String?
    public let start: String?
}

public enum ProjectPreviewStatus: String, Codable, Sendable, CaseIterable {
    case stopped, starting, running, restarting, offline, error
}

public enum ProjectPreviewVisibility: String, Codable, Sendable, CaseIterable {
    case tailnet, `public`
}

public enum ProjectPreviewTransport: String, Codable, Sendable, CaseIterable {
    case tailscaleServe = "tailscale-serve"
    case tailscaleFunnel = "tailscale-funnel"
    case directTailnet = "direct-tailnet"
}

public enum ProjectPreviewDesiredState: String, Codable, Sendable, CaseIterable {
    case running, stopped
}

public enum ProjectPreviewHealthState: String, Codable, Sendable, CaseIterable {
    case starting, healthy, degraded, unreachable, unknown
}

public struct ProjectPreviewHealth: Codable, Sendable, Hashable {
    public let state: ProjectPreviewHealthState
    public let checkedAt: Date
    public let latencyMs: Double?
    public let statusCode: Int?
    public let consecutiveFailures: Int
    public let detail: String
}

public struct ProjectPreviewLog: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let at: Date
    public let stream: String
    public let text: String
}

public struct ProjectPreview: Codable, Sendable, Hashable {
    public let projectId: String
    public let deviceId: String
    public let cwd: String
    public let status: ProjectPreviewStatus
    public let visibility: ProjectPreviewVisibility
    public let framework: String
    public let command: String
    public let port: Int
    public let servePort: Int
    public let url: String?
    public let tailscaleDnsName: String?
    public let transport: ProjectPreviewTransport?
    public let desiredState: ProjectPreviewDesiredState?
    public let autoStartWithCodex: Bool
    public let stopAfterMinutes: Int?
    public let restartCount: Int
    public let startedAt: Date?
    public let updatedAt: Date
    public let lastActivityAt: Date?
    public let lastHealthyAt: Date?
    public let health: ProjectPreviewHealth?
    public let error: String?
    public let logs: [ProjectPreviewLog]
}

public struct FleetProject: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let workspaceId: String?
    public let name: String
    public let description: String
    public let repository: String?
    public let defaultBranch: String
    public let paths: [FleetProjectPath]
    public let preferredDeviceIds: [String]
    public let commands: FleetProjectCommands
    public let artifactPaths: [String]
    public let preview: ProjectPreview?
    public let createdAt: Date
    public let updatedAt: Date
}

public enum FleetJobOutputStream: String, Codable, Sendable {
    case system, stdout, stderr, codex
}

public struct FleetJobOutputEvent: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let at: Date
    public let stream: FleetJobOutputStream
    public let text: String
    public let raw: JSONValue?
}

public struct FleetJob: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let kind: FleetJobKind
    public let prompt: String
    public let command: String?
    public let projectId: String?
    public let deviceId: String?
    public let cwd: String?
    public let status: FleetJobStatus
    public let permissionMode: FleetPermissionMode
    public let approvalPolicy: FleetApprovalPolicy
    public let requiredLabels: [String]
    public let progress: Double?
    public let phase: String?
    public let exitCode: Int?
    public let error: String?
    public let createdAt: Date
    public let startedAt: Date?
    public let completedAt: Date?
    public let output: [FleetJobOutputEvent]
}

public enum CodexEventType: String, Codable, Sendable {
    case user, assistant, reasoning, command, file, tool, plan, status, error, raw
}

public struct CodexActor: Codable, Sendable, Hashable {
    public let clientId: String
    public let name: String
    public let deviceName: String
}

public enum FleetDeviceMentionStatus: String, Codable, Sendable {
    case resolved, ambiguous, unknown
}

public struct FleetDeviceMention: Codable, Sendable, Hashable {
    public let token: String
    public let alias: String
    public let deviceIds: [String]
    public let label: String
    public let status: FleetDeviceMentionStatus
}

public enum FleetSystemReferenceKind: String, Codable, Sendable {
    case device
    case codexSession = "codex-session"
    case job, project, preview, telemetry
}

public struct FleetSystemReference: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let kind: FleetSystemReferenceKind
    public let label: String
    public let detail: String?
    public let status: String?
    public let deviceId: String?
    public let sessionId: String?
    public let jobId: String?
    public let projectId: String?
}

public struct FleetSystemPendingAction: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let kind: String
    public let action: FleetPowerAction
    public let deviceIds: [String]
    public let status: String
    public let requestedAt: Date
    public let completedAt: Date?
    public let error: String?
}

public enum FleetSystemMessageRole: String, Codable, Sendable {
    case user, assistant, system
}

public enum FleetConductorPlanStatus: String, Codable, Sendable, Hashable {
    case proposed, running, completed, partial, failed, cancelled
}

public enum FleetConductorStepStatus: String, Codable, Sendable, Hashable {
    case pending, blocked, running, completed, failed, skipped
}

public enum FleetConductorStepKind: String, Codable, Sendable, Hashable {
    case codex, preview
}

public struct FleetConductorStep: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let kind: FleetConductorStepKind
    public let title: String
    public let detail: String
    public let status: FleetConductorStepStatus
    public let deviceId: String?
    public let projectId: String?
    public let dependsOn: [String]
    public let permissionMode: FleetPermissionMode?
    public let selectionReason: String?
    public let sessionId: String?
    public let previewUrl: String?
    public let error: String?
}

public struct FleetConductorPlan: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let objective: String
    public let status: FleetConductorPlanStatus
    public let createdAt: Date
    public let updatedAt: Date
    public let actor: CodexActor?
    public let steps: [FleetConductorStep]
}

public struct FleetSystemMessage: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let at: Date
    public let role: FleetSystemMessageRole
    public let text: String
    public let actor: CodexActor?
    public let mentions: [FleetDeviceMention]
    public let references: [FleetSystemReference]
    public let pendingActionId: String?
    public let conductorPlanId: String?
}

public struct FleetSystemConversation: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let orchestratorDeviceId: String?
    public let codexSessionId: String?
    public let status: CodexSessionStatus?
    public let activeResponseMessageId: String?
    public let error: String?
    public let messages: [FleetSystemMessage]
    public let pendingActions: [FleetSystemPendingAction]
    public let conductorPlans: [FleetConductorPlan]?
    public let updatedAt: Date
}

public struct FleetSystemPowerResult: Codable, Sendable, Hashable {
    public let deviceId: String
    public let targetId: String?
    public let error: String?
}

public struct FleetSystemPowerResponse: Codable, Sendable, Hashable {
    public let action: FleetSystemPendingAction
    public let results: [FleetSystemPowerResult]
}

public struct CodexClientIdentity: Codable, Sendable, Hashable {
    public let clientId: String
    public let name: String
    public let deviceName: String

    public init(clientId: String, name: String, deviceName: String) {
        self.clientId = clientId
        self.name = name
        self.deviceName = deviceName
    }
}

public enum CodexParticipantPermission: String, Codable, Sendable, CaseIterable {
    case view, message, approve, interrupt, control
}

public struct CodexParticipant: Codable, Sendable, Hashable {
    public let clientId: String
    public let name: String
    public let deviceName: String
    public let permissions: [CodexParticipantPermission]
    public let typing: Bool
    public let connectedAt: Date
    public let lastSeenAt: Date
}

public struct CodexEvent: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let at: Date
    public let type: CodexEventType
    public let text: String
    public let method: String?
    public let data: JSONValue?
    public let actor: CodexActor?
}

public enum CodexRequestID: Sendable, Hashable, Codable, CustomStringConvertible {
    case string(String)
    case number(Double)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Codex request ID must be a string or number."
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        }
    }

    public var description: String {
        switch self {
        case let .string(value): value
        case let .number(value):
            value.rounded() == value ? String(Int64(value)) : String(value)
        }
    }
}

public struct CodexApproval: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let requestId: CodexRequestID
    public let method: String
    public let title: String
    public let detail: String
    public let params: JSONValue
    public let createdAt: Date
}

public struct CodexSession: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let deviceId: String
    public let projectId: String?
    public let cwd: String
    public let title: String
    public let kind: String?
    public let developerInstructions: String?
    public let threadId: String?
    public let turnId: String?
    public let model: String?
    public let permissionMode: FleetPermissionMode
    public let approvalPolicy: FleetApprovalPolicy
    public let status: CodexSessionStatus
    public let createdAt: Date
    public let updatedAt: Date
    public let events: [CodexEvent]
    public let pendingApprovals: [CodexApproval]
    public let participants: [CodexParticipant]?
    public let controllerClientId: String?
    public let controllerUpdatedAt: Date?
    public let error: String?
}

public struct CodexSessionEventUpdate: Codable, Sendable, Hashable {
    public let sessionId: String
    public let event: CodexEvent
    public let status: CodexSessionStatus
    public let updatedAt: Date
    public let turnId: String?
    public let error: String?
}

extension CodexSession {
    func mergingLiveProjection(_ incoming: CodexSession) -> CodexSession {
        let incomingEvents = Dictionary(uniqueKeysWithValues: incoming.events.map { ($0.id, $0) })
        let existingIDs = Set(events.map(\.id))
        let mergedEvents = (
            events.map { incomingEvents[$0.id] ?? $0 }
                + incoming.events.filter { !existingIDs.contains($0.id) }
        ).suffix(1_000)
        let newest = incoming.updatedAt >= updatedAt ? incoming : self
        return newest.replacingEvents(Array(mergedEvents))
    }

    func applying(_ update: CodexSessionEventUpdate) -> CodexSession {
        guard update.sessionId == id else { return self }
        var nextEvents = events
        if let index = nextEvents.firstIndex(where: { $0.id == update.event.id }) {
            nextEvents[index] = update.event
        } else {
            nextEvents.append(update.event)
            nextEvents = Array(nextEvents.suffix(1_000))
        }
        guard update.updatedAt >= updatedAt else {
            return replacingEvents(nextEvents)
        }
        return CodexSession(
            id: id,
            deviceId: deviceId,
            projectId: projectId,
            cwd: cwd,
            title: title,
            kind: kind,
            developerInstructions: developerInstructions,
            threadId: threadId,
            turnId: update.turnId ?? turnId,
            model: model,
            permissionMode: permissionMode,
            approvalPolicy: approvalPolicy,
            status: update.status,
            createdAt: createdAt,
            updatedAt: update.updatedAt,
            events: nextEvents,
            pendingApprovals: pendingApprovals,
            participants: participants,
            controllerClientId: controllerClientId,
            controllerUpdatedAt: controllerUpdatedAt,
            error: update.error
        )
    }

    private func replacingEvents(_ events: [CodexEvent]) -> CodexSession {
        CodexSession(
            id: id,
            deviceId: deviceId,
            projectId: projectId,
            cwd: cwd,
            title: title,
            kind: kind,
            developerInstructions: developerInstructions,
            threadId: threadId,
            turnId: turnId,
            model: model,
            permissionMode: permissionMode,
            approvalPolicy: approvalPolicy,
            status: status,
            createdAt: createdAt,
            updatedAt: updatedAt,
            events: events,
            pendingApprovals: pendingApprovals,
            participants: participants,
            controllerClientId: controllerClientId,
            controllerUpdatedAt: controllerUpdatedAt,
            error: error
        )
    }
}

public struct FleetTerminalSession: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let deviceId: String
    public let cwd: String
    public let shell: String
    public let cols: Int
    public let rows: Int
    public let createdAt: Date
    public let status: String
    public let exitCode: Int?
}

public enum FleetActivityType: String, Codable, Sendable {
    case device, job, session, terminal, project, security, system
}

public enum FleetActivitySeverity: String, Codable, Sendable {
    case info, success, warning, error
}

public struct FleetActivityEvent: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let at: Date
    public let type: FleetActivityType
    public let severity: FleetActivitySeverity
    public let title: String
    public let detail: String
    public let deviceId: String?
    public let entityId: String?
}

public struct FleetSettings: Codable, Sendable, Hashable {
    public let fleetName: String
    public let coreUrl: String
    public let heartbeatIntervalMs: Double
    public let offlineAfterMs: Double
    public let retainActivityDays: Int
    public let autoStartLocalAgent: Bool
    public let systemOrchestratorDeviceId: String?
}

public struct FleetAlert: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let ruleId: String?
    public let deviceId: String?
    public let jobId: String?
    public let severity: FleetAlertSeverity
    public let status: FleetAlertStatus
    public let title: String
    public let detail: String
    public let openedAt: Date
    public let acknowledgedAt: Date?
    public let acknowledgedBy: String?
    public let resolvedAt: Date?
    public let fingerprint: String
}

public struct FleetNotification: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let channelId: String?
    public let severity: FleetNotificationSeverity
    public let title: String
    public let body: String
    public let status: FleetNotificationStatus
    public let link: String?
    public let createdAt: Date
    public let sentAt: Date?
    public let readAt: Date?
    public let error: String?
}

public struct PipelineNodeRun: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let nodeId: String
    public let state: PipelineExecutionState
    public let deviceId: String?
    public let jobId: String?
    public let attempt: Int
    public let input: [String: JSONValue]
    public let output: [String: JSONValue]
    public let startedAt: Date?
    public let completedAt: Date?
    public let error: String?
}

public struct PipelineRun: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let pipelineId: String
    public let pipelineVersion: Int
    public let state: PipelineExecutionState
    public let triggerType: PipelineTriggerType
    public let parameters: [String: JSONValue]
    public let nodeRuns: [PipelineNodeRun]
    public let createdAt: Date
    public let startedAt: Date?
    public let completedAt: Date?
    public let createdBy: String
    public let error: String?
    public let estimatedCompletionAt: Date?
}

public struct PipelineDefinition: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let description: String
    public let projectId: String?
    public let version: Int
    public let status: String
    public let tags: [String]
    public let createdAt: Date
    public let updatedAt: Date
    public let createdBy: String
}

public struct FleetV2Snapshot: Codable, Sendable, Hashable {
    public let schemaVersion: Int
    public let protocolVersion: Int
    public let alerts: [FleetAlert]
    public let pipelines: [PipelineDefinition]
    public let pipelineRuns: [PipelineRun]
    public let notifications: [FleetNotification]
}

public struct FleetSnapshot: Codable, Sendable, Hashable {
    public let version: String
    public let now: Date
    public let devices: [FleetDevice]
    public let projects: [FleetProject]
    public let jobs: [FleetJob]
    public let sessions: [CodexSession]
    public let terminals: [FleetTerminalSession]
    public let activity: [FleetActivityEvent]
    public let settings: FleetSettings
    public let systemConversation: FleetSystemConversation
    public let systemConversations: [FleetSystemConversation]?
    public let v2: FleetV2Snapshot
}

public enum FleetMenuHealth: String, Codable, Sendable {
    case healthy, degraded, critical
}

public struct FleetMenuCore: Codable, Sendable, Hashable {
    public let status: String
    public let connected: Bool
    public let fleetName: String
    public let version: String
    public let schemaVersion: Int
    public let protocolVersion: Int
    public let url: String
}

public struct FleetMenuSummary: Codable, Sendable, Hashable {
    public let status: FleetMenuHealth
    public let totalDevices: Int
    public let onlineDevices: Int
    public let busyDevices: Int
    public let degradedDevices: Int
    public let sleepingDevices: Int
    public let offlineDevices: Int
    public let activeJobs: Int
    public let queuedJobs: Int
    public let failedJobs: Int
    public let pendingApprovals: Int
    public let openWarnings: Int
    public let openCriticalAlerts: Int
}

public struct FleetMenuJob: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let kind: FleetJobKind
    public let status: FleetJobStatus
    public let deviceId: String?
    public let deviceName: String?
    public let progress: Double?
    public let phase: String?
    public let createdAt: Date
    public let startedAt: Date?
    public let completedAt: Date?
    public let elapsedMs: Double?
    public let durationMs: Double?
    public let error: String?
}

public struct FleetMenuDeviceMetrics: Codable, Sendable, Hashable {
    public let cpuPercent: Double
    public let memoryPercent: Double
    public let storageMaxPercent: Double?
    public let gpuPercent: Double?
    public let vramUsedBytes: Double?
    public let vramTotalBytes: Double?
    public let temperatureCelsius: Double?
    public let batteryPercent: Double?
    public let powerDrawWatts: Double?
    public let sampledAt: Date
}

public struct FleetMenuDeviceCapabilities: Codable, Sendable, Hashable {
    public let codex: Bool
    public let cuda: Bool
    public let mlx: Bool
    public let tailscale: Bool
    public let wakeOnLan: Bool
    public let labels: [String]
}

public struct FleetMenuDevice: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let role: FleetDeviceRole
    public let status: FleetMenuDeviceStatus
    public let platform: String
    public let lastSeenAt: Date
    public let activeJobCount: Int
    public let metrics: FleetMenuDeviceMetrics
    public let capabilities: FleetMenuDeviceCapabilities
}

public struct FleetMenuCodexApproval: Identifiable, Codable, Sendable, Hashable {
    public let kind: String
    public let id: String
    public let sessionId: String
    public let requestId: CodexRequestID
    public let deviceId: String
    public let deviceName: String?
    public let projectId: String?
    public let title: String
    public let detail: String
    public let method: String
    public let createdAt: Date
}

public struct FleetMenuPipelineApproval: Identifiable, Codable, Sendable, Hashable {
    public let kind: String
    public let id: String
    public let pipelineRunId: String
    public let pipelineId: String
    public let pipelineName: String?
    public let nodeRunId: String
    public let nodeId: String
    public let deviceId: String?
    public let deviceName: String?
    public let title: String
    public let detail: String
    public let createdAt: Date
}

public enum FleetMenuApproval: Identifiable, Sendable, Hashable, Codable {
    case codex(FleetMenuCodexApproval)
    case pipeline(FleetMenuPipelineApproval)

    private enum CodingKeys: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "codex": self = .codex(try FleetMenuCodexApproval(from: decoder))
        case "pipeline": self = .pipeline(try FleetMenuPipelineApproval(from: decoder))
        case let value:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unsupported approval kind: \(value)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .codex(value): try value.encode(to: encoder)
        case let .pipeline(value): try value.encode(to: encoder)
        }
    }

    public var id: String {
        switch self {
        case let .codex(value): value.id
        case let .pipeline(value): value.id
        }
    }

    public var title: String {
        switch self {
        case let .codex(value): value.title
        case let .pipeline(value): value.title
        }
    }

    public var detail: String {
        switch self {
        case let .codex(value): value.detail
        case let .pipeline(value): value.detail
        }
    }

    public var createdAt: Date {
        switch self {
        case let .codex(value): value.createdAt
        case let .pipeline(value): value.createdAt
        }
    }
}

public struct FleetMenuAlert: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let severity: FleetAlertSeverity
    public let status: FleetAlertStatus
    public let title: String
    public let detail: String
    public let openedAt: Date
    public let deviceId: String?
    public let deviceName: String?
    public let jobId: String?
    public let jobName: String?
}

public struct FleetMenuRecentItem: Identifiable, Codable, Sendable, Hashable {
    public let id: String
    public let kind: String
    public let at: Date
    public let severity: FleetActivitySeverity
    public let title: String
    public let detail: String
    public let deviceId: String?
    public let deviceName: String?
    public let entityId: String?
    public let jobStatus: FleetJobStatus?
}

public struct FleetMenuSnapshot: Codable, Sendable, Hashable {
    public let generatedAt: Date
    public let core: FleetMenuCore
    public let summary: FleetMenuSummary
    public let jobs: [FleetMenuJob]
    public let devices: [FleetMenuDevice]
    public let approvals: [FleetMenuApproval]
    public let alerts: [FleetMenuAlert]
    public let recent: [FleetMenuRecentItem]
}

public struct FleetHealth: Codable, Sendable, Hashable {
    public let ok: Bool
    public let version: String
    public let now: Date
}

public enum FleetWorkspaceEntryType: String, Codable, Sendable, Hashable {
    case directory, file, symlink, other
}

public struct FleetWorkspaceEntry: Identifiable, Codable, Sendable, Hashable {
    public var id: String { path }
    public let name: String
    public let path: String
    public let type: FleetWorkspaceEntryType
    public let sizeBytes: Double
    public let modifiedAt: Date
}

public struct FleetWorkspacePage: Codable, Sendable, Hashable {
    public let path: String
    public let entries: [FleetWorkspaceEntry]
    public let nextCursor: String?
    public let total: Int
}

public struct FleetWorkspaceDirectoryResult: Codable, Sendable, Hashable {
    public let path: String
    public let created: Bool
}

public struct DevicePowerResult: Codable, Sendable, Hashable {
    public let deviceId: String
    public let targetId: String?
    public let result: JSONValue?
    public let error: String?
}

public struct DevicePowerRejection: Codable, Sendable, Hashable {
    public let deviceId: String
    public let reason: String?
}

public struct DevicePowerResponse: Codable, Sendable, Hashable {
    public let action: FleetPowerAction
    public let results: [DevicePowerResult]
    public let accepted: [String]?
    public let rejected: [DevicePowerRejection]?
}

public struct CreateFleetJobRequest: Encodable, Sendable {
    public let name: String
    public let kind: FleetJobKind
    public let prompt: String?
    public let command: String?
    public let deviceId: String?
    public let projectId: String?
    public let cwd: String?
    public let permissionMode: FleetPermissionMode
    public let approvalPolicy: FleetApprovalPolicy
    public let requiredLabels: [String]

    public init(
        name: String,
        kind: FleetJobKind,
        prompt: String? = nil,
        command: String? = nil,
        deviceId: String? = nil,
        projectId: String? = nil,
        cwd: String? = nil,
        permissionMode: FleetPermissionMode = .workspaceWrite,
        approvalPolicy: FleetApprovalPolicy = .onRequest,
        requiredLabels: [String] = []
    ) {
        self.name = name
        self.kind = kind
        self.prompt = prompt
        self.command = command
        self.deviceId = deviceId
        self.projectId = projectId
        self.cwd = cwd
        self.permissionMode = permissionMode
        self.approvalPolicy = approvalPolicy
        self.requiredLabels = requiredLabels
    }
}

public struct CreateCodexSessionRequest: Encodable, Sendable {
    public let deviceId: String
    public let projectId: String?
    public let cwd: String
    public let title: String
    public let model: String?
    public let permissionMode: FleetPermissionMode
    public let approvalPolicy: FleetApprovalPolicy

    public init(
        deviceId: String,
        projectId: String? = nil,
        cwd: String,
        title: String = "Codex session",
        model: String? = nil,
        permissionMode: FleetPermissionMode = .workspaceWrite,
        approvalPolicy: FleetApprovalPolicy = .onRequest
    ) {
        self.deviceId = deviceId
        self.projectId = projectId
        self.cwd = cwd
        self.title = title
        self.model = model
        self.permissionMode = permissionMode
        self.approvalPolicy = approvalPolicy
    }
}

public struct FleetLiveEvent: Codable, Sendable, Hashable {
    public let type: String
    public let payload: JSONValue

    public func decodePayload<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try payload.decode(type)
    }
}
