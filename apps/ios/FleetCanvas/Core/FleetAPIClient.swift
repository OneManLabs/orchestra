import Foundation

public enum FleetHTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

public actor FleetAPIClient {
    public static let shared = FleetAPIClient()

    private var connection: FleetConnection?
    private var network: NetworkContext?

    public init(connection: FleetConnection? = nil) {
        self.connection = connection
    }

    public func configure(_ connection: FleetConnection) {
        network?.session.invalidateAndCancel()
        network = nil
        self.connection = connection
    }

    public func configure(coreURL: String, token: String) throws {
        configure(try FleetConnection(coreURL: coreURL, token: token))
    }

    public func clearConnection() {
        network?.session.invalidateAndCancel()
        network = nil
        connection = nil
    }

    public func currentConnection() -> FleetConnection? {
        connection
    }

    public func health() async throws -> FleetHealth {
        try await request("/api/health")
    }

    public func snapshot() async throws -> FleetSnapshot {
        try await request("/api/snapshot")
    }

    public func menuSnapshot() async throws -> FleetMenuSnapshot {
        try await request("/api/v2/menu-bar")
    }

    public func devices() async throws -> [FleetDevice] {
        try await request("/api/devices")
    }

    public func deviceWorkspace(
        deviceID: String,
        path: String,
        cursor: String? = nil
    ) async throws -> FleetWorkspacePage {
        var components = URLComponents()
        components.path = "/api/devices/\(try resourceID(deviceID))/workspace"
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        if let cursor {
            components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor))
        }
        guard let requestPath = components.string else {
            throw FleetAPIError.invalidRequest("The workspace path could not be encoded.")
        }
        return try await request(requestPath)
    }

    public func createDeviceWorkspaceDirectory(
        deviceID: String,
        path: String
    ) async throws -> FleetWorkspaceDirectoryResult {
        try await request(
            "/api/devices/\(try resourceID(deviceID))/workspace/directories",
            method: .post,
            body: WorkspaceDirectoryBody(path: path)
        )
    }

    public func jobs() async throws -> [FleetJob] {
        try await request("/api/jobs")
    }

    public func createJob(_ input: CreateFleetJobRequest) async throws -> FleetJob {
        try await request("/api/jobs", method: .post, body: input)
    }

    public func startJob(id: String) async throws -> FleetJob {
        try await request("/api/jobs/\(try resourceID(id))/start", method: .post, body: EmptyBody())
    }

    public func cancelJob(id: String) async throws -> FleetJob {
        try await request("/api/jobs/\(try resourceID(id))/cancel", method: .post, body: EmptyBody())
    }

    public func alerts() async throws -> [FleetAlert] {
        try await request("/api/v2/alerts")
    }

    public func acknowledgeAlert(id: String) async throws -> FleetAlert {
        try await request("/api/v2/alerts/\(try resourceID(id))/acknowledge", method: .post, body: EmptyBody())
    }

    public func resolveAlert(id: String) async throws -> FleetAlert {
        try await request("/api/v2/alerts/\(try resourceID(id))/resolve", method: .post, body: EmptyBody())
    }

    public func notifications() async throws -> [FleetNotification] {
        try await request("/api/v2/notifications")
    }

    public func markNotificationRead(id: String) async throws -> FleetNotification {
        try await request("/api/v2/notifications/\(try resourceID(id))/read", method: .post, body: EmptyBody())
    }

    public func sendNotification(
        severity: FleetNotificationSeverity,
        title: String,
        body: String,
        channelIds: [String]? = nil
    ) async throws -> [FleetNotification] {
        try await request(
            "/api/v2/notifications",
            method: .post,
            body: SendNotificationBody(severity: severity, title: title, body: body, channelIds: channelIds)
        )
    }

    public func sessions() async throws -> [CodexSession] {
        try await request("/api/sessions")
    }

    public func systemConversation() async throws -> FleetSystemConversation {
        try await request("/api/system")
    }

    public func sendSystemMessage(
        text: String,
        mode: String = "chat",
        client: CodexClientIdentity? = nil
    ) async throws -> FleetSystemConversation {
        try await request(
            "/api/system/messages",
            method: .post,
            body: FleetSystemMessageBody(text: text, mode: mode, client: client)
        )
    }

    public func executeConductorPlan(
        id: String,
        client: CodexClientIdentity? = nil
    ) async throws -> FleetConductorPlan {
        try await request(
            "/api/system/conductor/plans/\(try resourceID(id))/execute",
            method: .post,
            body: FleetSystemConversationActionBody(client: client)
        )
    }

    public func cancelConductorPlan(
        id: String,
        client: CodexClientIdentity? = nil
    ) async throws -> FleetConductorPlan {
        try await request(
            "/api/system/conductor/plans/\(try resourceID(id))/cancel",
            method: .post,
            body: FleetSystemConversationActionBody(client: client)
        )
    }

    public func newSystemConversation(
        client: CodexClientIdentity? = nil
    ) async throws -> FleetSystemConversation {
        try await request(
            "/api/system/new",
            method: .post,
            body: FleetSystemConversationActionBody(client: client)
        )
    }

    public func clearSystemConversation(
        client: CodexClientIdentity? = nil
    ) async throws -> FleetSystemConversation {
        try await request(
            "/api/system/clear",
            method: .post,
            body: FleetSystemConversationActionBody(client: client)
        )
    }

    public func confirmSystemPowerAction(
        id: String,
        action: FleetPowerAction,
        deviceIds: [String],
        client: CodexClientIdentity? = nil
    ) async throws -> FleetSystemPowerResponse {
        try await request(
            "/api/system/power-actions/\(try resourceID(id))/confirm",
            method: .post,
            body: FleetSystemPowerConfirmationBody(deviceIds: deviceIds, action: action, client: client)
        )
    }

    public func createSession(_ input: CreateCodexSessionRequest) async throws -> CodexSession {
        try await request("/api/sessions", method: .post, body: input)
    }

    public func updateSessionPermission(
        id: String,
        permissionMode: FleetPermissionMode,
        client: CodexClientIdentity? = nil
    ) async throws -> CodexSession {
        try await request(
            "/api/sessions/\(try resourceID(id))/permissions",
            method: .patch,
            body: CodexPermissionBody(permissionMode: permissionMode, client: client)
        )
    }

    public func sendMessage(
        sessionID: String,
        text: String,
        client: CodexClientIdentity? = nil
    ) async throws -> CodexSession {
        try await request(
            "/api/sessions/\(try resourceID(sessionID))/messages",
            method: .post,
            body: CodexMessageBody(text: text, client: client)
        )
    }

    public func resumeSession(id: String) async throws -> CodexSession {
        try await request("/api/sessions/\(try resourceID(id))/resume", method: .post, body: EmptyBody())
    }

    public func forkSession(
        id: String,
        deviceID: String,
        title: String,
        lastTurnID: String? = nil
    ) async throws -> CodexSession {
        try await request(
            "/api/sessions/\(try resourceID(id))/fork",
            method: .post,
            body: CodexForkBody(deviceId: deviceID, title: title, lastTurnId: lastTurnID)
        )
    }

    public func interruptSession(
        id: String,
        client: CodexClientIdentity? = nil
    ) async throws -> CodexSession {
        try await request(
            "/api/sessions/\(try resourceID(id))/interrupt",
            method: .post,
            body: CodexInterruptBody(client: client)
        )
    }

    public func stopSession(id: String) async throws -> CodexSession {
        try await request("/api/sessions/\(try resourceID(id))/stop", method: .post, body: EmptyBody())
    }

    public func respondToApproval(
        sessionID: String,
        requestID: CodexRequestID,
        result: JSONValue,
        client: CodexClientIdentity? = nil
    ) async throws -> CodexSession {
        try await request(
            "/api/sessions/\(try resourceID(sessionID))/respond",
            method: .post,
            body: CodexApprovalBody(requestId: requestID, result: result, client: client)
        )
    }

    public func startProjectPreview(
        projectID: String,
        deviceID: String? = nil,
        visibility: ProjectPreviewVisibility = .tailnet,
        autoStartWithCodex: Bool = true,
        stopAfterMinutes: Int? = nil
    ) async throws -> ProjectPreview {
        try await request(
            "/api/projects/\(try resourceID(projectID))/preview/start",
            method: .post,
            body: StartProjectPreviewBody(
                deviceId: deviceID,
                visibility: visibility,
                confirmPublic: visibility == .public,
                autoStartWithCodex: autoStartWithCodex,
                stopAfterMinutes: stopAfterMinutes
            )
        )
    }

    public func stopProjectPreview(projectID: String) async throws -> ProjectPreview {
        try await request(
            "/api/projects/\(try resourceID(projectID))/preview/stop",
            method: .post,
            body: EmptyBody()
        )
    }

    public func touchProjectPreview(projectID: String) async throws -> ProjectPreview {
        try await request(
            "/api/projects/\(try resourceID(projectID))/preview/activity",
            method: .post,
            body: EmptyBody()
        )
    }

    public func updateCodexPresence(
        sessionID: String,
        client: CodexClientIdentity,
        typing: Bool
    ) async throws -> CodexPresenceResponse {
        try await request(
            "/api/sessions/\(try resourceID(sessionID))/presence",
            method: .post,
            body: CodexPresenceBody(
                clientId: client.clientId,
                name: client.name,
                deviceName: client.deviceName,
                typing: typing
            )
        )
    }

    public func requestCodexControl(
        sessionID: String,
        client: CodexClientIdentity
    ) async throws -> CodexSession {
        try await request(
            "/api/sessions/\(try resourceID(sessionID))/control",
            method: .post,
            body: CodexControlBody(
                clientId: client.clientId,
                name: client.name,
                deviceName: client.deviceName,
                force: false
            )
        )
    }

    public func pipelineRuns() async throws -> [PipelineRun] {
        try await request("/api/v2/pipeline-runs")
    }

    public func approvePipelineNode(
        runID: String,
        nodeRunID: String,
        input: [String: JSONValue] = [:]
    ) async throws -> PipelineRun {
        try await pipelineApproval(runID: runID, nodeRunID: nodeRunID, approved: true, input: input)
    }

    public func rejectPipelineNode(
        runID: String,
        nodeRunID: String,
        input: [String: JSONValue] = [:]
    ) async throws -> PipelineRun {
        try await pipelineApproval(runID: runID, nodeRunID: nodeRunID, approved: false, input: input)
    }

    public func power(
        deviceIDs: [String],
        action: FleetPowerAction,
        force: Bool = false
    ) async throws -> DevicePowerResponse {
        try await request(
            "/api/v2/devices/power",
            method: .post,
            body: PowerBody(deviceIds: deviceIDs, action: action, force: force)
        )
    }

    public func liveEventStream(autoReconnect: Bool = true) throws -> FleetLiveEventStream {
        guard let connection else { throw FleetAPIError.missingCredentials }
        return FleetLiveEventStream(connection: connection, autoReconnect: autoReconnect)
    }

    /// Performs a typed GET (or body-free method) while preserving the
    /// configured Orchestra origin and bearer credential.
    public func request<Response: Decodable & Sendable>(
        _ path: String,
        method: FleetHTTPMethod = .get,
        as type: Response.Type = Response.self
    ) async throws -> Response {
        try await execute(path: path, method: method, body: nil, as: type)
    }

    /// Performs a typed JSON request. This helper is intended for extensions
    /// and future Orchestra endpoints while retaining all origin/auth checks.
    public func request<Body: Encodable & Sendable, Response: Decodable & Sendable>(
        _ path: String,
        method: FleetHTTPMethod,
        body: Body,
        as type: Response.Type = Response.self
    ) async throws -> Response {
        let data: Data
        do {
            data = try FleetCoding.encoder.encode(body)
        } catch {
            throw FleetAPIError.encoding(String(describing: error))
        }
        return try await execute(path: path, method: method, body: data, as: type)
    }

    private func pipelineApproval(
        runID: String,
        nodeRunID: String,
        approved: Bool,
        input: [String: JSONValue]
    ) async throws -> PipelineRun {
        try await request(
            "/api/v2/pipeline-runs/\(try resourceID(runID))/approve",
            method: .post,
            body: PipelineApprovalBody(nodeRunId: nodeRunID, approved: approved, input: input)
        )
    }

    private func execute<Response: Decodable & Sendable>(
        path: String,
        method: FleetHTTPMethod,
        body: Data?,
        as type: Response.Type
    ) async throws -> Response {
        guard let connection else { throw FleetAPIError.missingCredentials }
        let url = try connection.origin.appending(path: path)
        let context = networkContext(for: connection.origin)
        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.timeoutInterval = 60
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await context.session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw FleetAPIError.transport(networkErrorDescription(error))
        }
        guard let http = response as? HTTPURLResponse else {
            throw FleetAPIError.invalidResponse
        }
        guard let finalURL = http.url, connection.origin.contains(finalURL) else {
            throw FleetAPIError.redirectedOutsideOrigin
        }
        guard (200..<300).contains(http.statusCode) else {
            throw httpError(statusCode: http.statusCode, data: data)
        }
        do {
            return try FleetCoding.decoder.decode(type, from: data)
        } catch {
            throw FleetAPIError.decoding(decodingDescription(error))
        }
    }

    private func networkContext(for origin: FleetCoreOrigin) -> NetworkContext {
        if let network, network.origin == origin { return network }
        network?.session.invalidateAndCancel()
        let delegate = FleetOriginSessionDelegate(origin: origin)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 120
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let created = NetworkContext(origin: origin, session: session, delegate: delegate)
        network = created
        return created
    }

    private func resourceID(_ value: String) throws -> String {
        try fleetEncodedPathComponent(value)
    }
}

private struct NetworkContext {
    let origin: FleetCoreOrigin
    let session: URLSession
    // URLSession retains its delegate, but retaining it explicitly documents
    // the lifetime and avoids implementation-specific delegate release.
    let delegate: FleetOriginSessionDelegate
}

private struct EmptyBody: Encodable, Sendable {}
private struct WorkspaceDirectoryBody: Encodable, Sendable {
    let path: String
}
private struct CodexMessageBody: Encodable, Sendable {
    let text: String
    let client: CodexClientIdentity?
}
private struct CodexForkBody: Encodable, Sendable {
    let deviceId: String
    let title: String
    let lastTurnId: String?
}
private struct CodexPermissionBody: Encodable, Sendable {
    let permissionMode: FleetPermissionMode
    let client: CodexClientIdentity?
}
private struct FleetSystemMessageBody: Encodable, Sendable {
    let text: String
    let mode: String
    let client: CodexClientIdentity?
}
private struct FleetSystemConversationActionBody: Encodable, Sendable {
    let client: CodexClientIdentity?
}
private struct FleetSystemPowerConfirmationBody: Encodable, Sendable {
    let deviceIds: [String]
    let action: FleetPowerAction
    let client: CodexClientIdentity?
}
private struct CodexInterruptBody: Encodable, Sendable {
    let client: CodexClientIdentity?
}
private struct CodexApprovalBody: Encodable, Sendable {
    let requestId: CodexRequestID
    let result: JSONValue
    let client: CodexClientIdentity?
}
private struct StartProjectPreviewBody: Encodable, Sendable {
    let deviceId: String?
    let visibility: ProjectPreviewVisibility
    let confirmPublic: Bool
    let autoStartWithCodex: Bool
    let stopAfterMinutes: Int?
}
private struct CodexPresenceBody: Encodable, Sendable {
    let clientId: String
    let name: String
    let deviceName: String
    let typing: Bool
}
private struct CodexControlBody: Encodable, Sendable {
    let clientId: String
    let name: String
    let deviceName: String
    let force: Bool
}
private struct PipelineApprovalBody: Encodable, Sendable {
    let nodeRunId: String
    let approved: Bool
    let input: [String: JSONValue]
}
private struct PowerBody: Encodable, Sendable {
    let deviceIds: [String]
    let action: FleetPowerAction
    let force: Bool
}
private struct SendNotificationBody: Encodable, Sendable {
    let severity: FleetNotificationSeverity
    let title: String
    let body: String
    let channelIds: [String]?
}

public struct CodexPresenceResponse: Codable, Sendable, Hashable {
    public let participant: CodexParticipant
    public let controllerClientId: String?
}

internal final class FleetOriginSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let origin: FleetCoreOrigin

    init(origin: FleetCoreOrigin) {
        self.origin = origin
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(origin.contains(request.url ?? response.url!) ? request : nil)
    }
}

internal func httpError(statusCode: Int, data: Data) -> FleetAPIError {
    var payload: JSONValue?
    if !data.isEmpty {
        payload = try? FleetCoding.decoder.decode(JSONValue.self, from: data)
    }
    let serverMessage = payload?["error"]?.stringValue
        ?? payload?["message"]?.stringValue
        ?? String(data: data.prefix(1_000), encoding: .utf8)
    let fallback: String
    switch statusCode {
    case 401: fallback = "Orchestra authentication is required."
    case 403: fallback = "This credential is not allowed to perform that Orchestra action."
    case 404: fallback = "The requested Orchestra resource was not found."
    case 409: fallback = "Orchestra could not perform this action in the resource’s current state."
    case 429: fallback = "Orchestra Core is receiving too many requests. Try again shortly."
    default: fallback = "Orchestra Core request failed (HTTP \(statusCode))."
    }
    let message = serverMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
    return .http(statusCode: statusCode, message: message?.isEmpty == false ? message! : fallback, payload: payload)
}

internal func networkErrorDescription(_ error: Error) -> String {
    let nsError = error as NSError
    switch nsError.code {
    case NSURLErrorNotConnectedToInternet:
        return "The iPhone is offline."
    case NSURLErrorCannotFindHost:
        return "The Orchestra Core host could not be found."
    case NSURLErrorCannotConnectToHost:
        return "Orchestra Core refused the connection."
    case NSURLErrorTimedOut:
        return "The connection timed out."
    case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted:
        return "The secure connection or certificate could not be verified."
    case NSURLErrorCancelled:
        return "The request was cancelled or redirected outside the configured Orchestra origin."
    default:
        return nsError.localizedDescription
    }
}

internal func decodingDescription(_ error: Error) -> String {
    guard let error = error as? DecodingError else { return String(describing: error) }
    func path(_ context: DecodingError.Context) -> String {
        let value = context.codingPath.map(\.stringValue).joined(separator: ".")
        return value.isEmpty ? "response" : value
    }
    switch error {
    case let .dataCorrupted(context):
        return "\(path(context)): \(context.debugDescription)"
    case let .keyNotFound(key, context):
        return "\(path(context)).\(key.stringValue) is missing."
    case let .typeMismatch(_, context):
        return "\(path(context)): \(context.debugDescription)"
    case let .valueNotFound(_, context):
        return "\(path(context)): \(context.debugDescription)"
    @unknown default:
        return "Unknown JSON decoding failure."
    }
}
