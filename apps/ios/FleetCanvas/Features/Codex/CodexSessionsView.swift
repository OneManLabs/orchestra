import SwiftUI
import UIKit

struct CodexSessionsView: View {
    @Environment(FleetStore.self) private var store
    @State private var query = ""
    @State private var showingNewSession = false
    @State private var sessionNavigation = CodexSessionNavigationState()

    private var filteredSessions: [CodexSession] {
        store.sessions
            .filter {
                query.isEmpty ||
                    $0.title.localizedCaseInsensitiveContains(query) ||
                    $0.cwd.localizedCaseInsensitiveContains(query) ||
                    ($0.model?.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private var currentSessions: [CodexSession] {
        let filteredIDs = Set(filteredSessions.map(\.id))
        return store.currentCodexSessions.filter { filteredIDs.contains($0.id) }
    }

    private var recentSessions: [CodexSession] {
        let filteredIDs = Set(filteredSessions.map(\.id))
        return store.recentCodexSessions.filter { filteredIDs.contains($0.id) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if let error = store.lastError {
                    FleetInlineError(message: error) {
                        Task { await store.refresh() }
                    }
                }

                codexSummary

                if filteredSessions.isEmpty {
                    FleetMobileCard {
                        FleetMobileEmptyState(
                            icon: "sparkles",
                            title: store.sessions.isEmpty ? "No Codex sessions" : "No matching sessions",
                            message: store.sessions.isEmpty
                                ? "Start a session on any Codex-capable device and keep working from your iPhone."
                                : "Try another title, workspace, or model.",
                            actionTitle: store.sessions.isEmpty ? "Start a session" : nil
                        ) {
                            showingNewSession = true
                        }
                    }
                } else {
                    if !currentSessions.isEmpty {
                        FleetMobileSectionHeader(
                            title: "Current sessions",
                            detail: "Live Codex conversations across your fleet"
                        )
                        ForEach(currentSessions) { session in
                            sessionLink(session)
                        }
                    }

                    if !recentSessions.isEmpty {
                        FleetMobileSectionHeader(
                            title: "Recent sessions",
                            detail: "Stopped and failed conversation history"
                        )
                        .padding(.top, currentSessions.isEmpty ? 0 : 4)
                        ForEach(recentSessions) { session in
                            sessionLink(session)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 28)
        }
        .refreshable { await store.refresh() }
        .navigationTitle("Codex")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, prompt: "Search sessions")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewSession = true
                } label: {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Start a Codex session")
            }
        }
        .sheet(isPresented: $showingNewSession, onDismiss: {
            sessionNavigation.presentPendingSession()
        }) {
            NewCodexSessionView { sessionID in
                sessionNavigation.recordCreatedSession(sessionID)
            }
        }
        .navigationDestination(
            isPresented: Binding(
                get: { sessionNavigation.presentedSessionID != nil },
                set: { if !$0 { sessionNavigation.dismissPresentedSession() } }
            )
        ) {
            if let sessionID = sessionNavigation.presentedSessionID {
                CodexChatView(sessionID: sessionID)
            }
        }
        .fleetMobileBackground()
    }

    private func sessionLink(_ session: CodexSession) -> some View {
        NavigationLink {
            CodexChatView(sessionID: session.id)
        } label: {
            CodexSessionCard(
                session: session,
                device: store.devices.first { $0.id == session.deviceId },
                project: store.projects.first { $0.id == session.projectId }
            )
        }
        .buttonStyle(.plain)
    }

    private var codexSummary: some View {
        FleetMobileCard {
            HStack(spacing: 0) {
                CodexSummaryStat(
                    value: "\(store.sessions.filter { $0.status == .thinking || $0.status == .starting }.count)",
                    label: "Working",
                    tone: .cyan
                )
                Divider().overlay(MobileFleetPalette.border)
                CodexSummaryStat(
                    value: "\(store.sessions.filter { $0.status == .ready || $0.status == .completed }.count)",
                    label: "Ready",
                    tone: .green
                )
                Divider().overlay(MobileFleetPalette.border)
                CodexSummaryStat(
                    value: "\(store.sessions.reduce(0) { $0 + $1.pendingApprovals.count })",
                    label: "Approvals",
                    tone: .amber
                )
                Divider().overlay(MobileFleetPalette.border)
                CodexSummaryStat(
                    value: "\(store.sessions.filter { $0.status == .error }.count)",
                    label: "Errors",
                    tone: .red
                )
            }
            .frame(height: 48)
        }
    }
}

struct CodexChatView: View {
    @Environment(FleetStore.self) private var store
    @Environment(\.openURL) private var openURL
    let sessionID: String

    @State private var showingStopConfirmation = false
    @State private var scrollRequest = 0
    @State private var branchedSessionID: String?

    private var session: CodexSession? {
        store.sessions.first { $0.id == sessionID }
    }

    private var device: FleetDevice? {
        guard let deviceID = session?.deviceId else { return nil }
        return store.devices.first { $0.id == deviceID }
    }

    private var project: FleetProject? {
        guard let session else { return nil }
        if let projectID = session.projectId,
           let exact = store.projects.first(where: { $0.id == projectID }) {
            return exact
        }
        return store.projects
            .compactMap { project -> (FleetProject, Int)? in
                let matchingLength = project.paths
                    .filter { $0.deviceId == session.deviceId }
                    .filter {
                        codexProjectPathContainsSessionCWD(
                            projectPath: $0.path,
                            sessionCWD: session.cwd
                        )
                    }
                    .map { normalizedFleetPath($0.path).count }
                    .max()
                guard let matchingLength else { return nil }
                return (project, matchingLength)
            }
            .max { $0.1 < $1.1 }?
            .0
    }

    var body: some View {
        VStack(spacing: 0) {
            if let session {
                sessionContext(session)
                collaborationContext(session)

                if device?.status == .offline {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "wifi.slash")
                            .foregroundStyle(MobileFleetPalette.red)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Session paused")
                                .font(.caption.weight(.bold))
                            Text("The execution device is offline. Conversation history remains available and Codex can resume when it reconnects.")
                                .font(.caption2)
                                .foregroundStyle(MobileFleetPalette.mutedText)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(MobileFleetPalette.red.opacity(0.08))
                }

                if let project,
                   project.preview?.status == .running,
                   let value = project.preview?.url,
                   let url = safeFleetPreviewURL(value) {
                    Button {
                        Task { await store.touchProjectPreview(project.id) }
                        openURL(url)
                    } label: {
                        Label("Open \(project.name) Website", systemImage: "arrow.up.right.square")
                            .font(.caption.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                    .padding(.vertical, 9)
                    .background(MobileFleetPalette.cyan.opacity(0.07))
                    .overlay(alignment: .bottom) {
                        Divider().overlay(MobileFleetPalette.softBorder)
                    }
                } else if let project,
                          let preview = project.preview,
                          let setupURL = preview.error?.codexTailscaleSetupURL {
                    Button {
                        openURL(setupURL)
                    } label: {
                        Label(
                            "Enable Tailscale \(preview.visibility == .public ? "Funnel" : "Serve")",
                            systemImage: "shield.checkered"
                        )
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(MobileFleetPalette.amber)
                    .padding(.vertical, 9)
                    .background(MobileFleetPalette.amber.opacity(0.07))
                    .overlay(alignment: .bottom) {
                        Divider().overlay(MobileFleetPalette.softBorder)
                    }
                }

                ScrollView {
                    LazyVStack(spacing: 14) {
                        if session.events.isEmpty {
                            FleetMobileEmptyState(
                                icon: "bubble.left.and.bubble.right",
                                title: "Session ready",
                                message: "Send the first instruction to Codex on \(device?.name ?? "this device")."
                            )
                            .padding(.top, 28)
                        } else {
                            ForEach(session.events.filter { $0.type != .raw }) { event in
                                let isLatestAssistant = session.events.last(where: { $0.type == .assistant })?.id == event.id
                                CodexEventBubble(
                                    event: event,
                                    sessionID: session.id,
                                    sources: codexMessageSources(for: event, in: session.events),
                                    canBranch: event.type == .assistant &&
                                        device?.status != .offline &&
                                        device?.capabilities.labels.contains("feature:codex-session-mobility") == true &&
                                        session.threadId != nil &&
                                        [.ready, .completed, .stopped].contains(session.status) &&
                                        (codexEventTurnID(event) != nil || isLatestAssistant),
                                    onBranch: { branchedSessionID = $0 }
                                )
                                    .equatable()
                                    .id(event.id)
                                    .accessibilityIdentifier("codex-transcript-event-\(event.id)")
                            }
                        }

                        if session.status == .thinking || session.status == .starting {
                            CodexThinkingRow(status: session.status)
                                .id("thinking")
                        }

                        ForEach(session.pendingApprovals) { approval in
                            CodexInlineApproval(
                                approval: approval,
                                menuApproval: store.approvals.first { $0.id == approval.id }
                            )
                            .id("approval-\(approval.id)")
                        }

                        if let error = session.error {
                            FleetInlineError(message: error)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
                }
                .fleetChatTranscriptBehavior(scrollRequest: scrollRequest, contentVersion: session.updatedAt)
                .accessibilityIdentifier("codex-transcript")

                CodexComposer(
                    sessionID: session.id,
                    context: CodexComposerContext(session: session, device: device),
                    onMessageSent: requestScrollToBottom
                )
                .equatable()
            } else {
                FleetMobileEmptyState(
                    icon: "questionmark.bubble",
                    title: "Session unavailable",
                    message: "This Codex session is no longer present in the current Orchestra snapshot."
                )
                .padding(16)
                Spacer()
            }
        }
        .navigationTitle(session?.title ?? "Codex")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let project,
                   project.preview?.status == .running,
                   let value = project.preview?.url,
                   let url = safeFleetPreviewURL(value) {
                    Button {
                        Task { await store.touchProjectPreview(project.id) }
                        openURL(url)
                    } label: {
                        Image(systemName: "safari")
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Open \(project.name) Website")
                }

                Menu {
                    if let session, session.status == .stopped {
                        Button {
                            Task { await store.resumeSession(session.id) }
                        } label: {
                            Label("Resume Session", systemImage: "play.fill")
                        }
                    }
                    Button(role: .destructive) {
                        showingStopConfirmation = true
                    } label: {
                        Label("Stop Session", systemImage: "stop.fill")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Session actions")
            }
        }
        .confirmationDialog(
            "Stop this Codex session?",
            isPresented: $showingStopConfirmation,
            titleVisibility: .visible
        ) {
            Button("Stop Session", role: .destructive) {
                Task { await store.stopSession(sessionID) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The conversation remains in Orchestra history and may be resumed later.")
        }
        .navigationDestination(
            isPresented: Binding(
                get: { branchedSessionID != nil },
                set: { if !$0 { branchedSessionID = nil } }
            )
        ) {
            if let branchedSessionID {
                CodexChatView(sessionID: branchedSessionID)
            }
        }
        .fleetMobileBackground()
    }

    private func requestScrollToBottom() {
        scrollRequest &+= 1
    }

    private func sessionContext(_ session: CodexSession) -> some View {
        HStack(spacing: 10) {
            FleetStatusDot(
                tone: session.status.fleetTone,
                animated: session.status == .thinking || session.status == .starting
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(device?.name ?? "Unknown device")
                    .font(.caption.weight(.semibold))
                Text([project?.name, session.cwd].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            FleetMobileStatusPill(text: session.status.displayName, tone: session.status.tone)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 54)
        .background(MobileFleetPalette.panel.opacity(0.97))
        .overlay(alignment: .bottom) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
        .accessibilityElement(children: .combine)
    }

    private func collaborationContext(_ session: CodexSession) -> some View {
        let participants = session.participants ?? []
        let hasControl = session.controllerClientId == store.codexIdentity.clientId
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(participants, id: \.clientId) { participant in
                    HStack(spacing: 5) {
                        Text(participant.name.prefix(1).uppercased())
                            .font(.caption2.weight(.bold))
                            .frame(width: 21, height: 21)
                            .background(
                                MobileFleetPalette.cyan.opacity(0.14),
                                in: Circle()
                            )
                        Text(participant.name)
                        if participant.typing && participant.clientId != store.codexIdentity.clientId {
                            Text("typing…")
                                .foregroundStyle(MobileFleetPalette.cyanBright)
                        }
                        if participant.clientId == session.controllerClientId {
                            Image(systemName: "crown.fill")
                                .foregroundStyle(MobileFleetPalette.amber)
                        }
                    }
                    .font(.caption2)
                    .padding(.trailing, 8)
                    .padding(.leading, 3)
                    .frame(height: 29)
                    .background(
                        MobileFleetPalette.raisedPanel,
                        in: Capsule()
                    )
                    .overlay {
                        Capsule().stroke(MobileFleetPalette.border, lineWidth: 1)
                    }
                    .accessibilityLabel(
                        "\(participant.name) on \(participant.deviceName)" +
                            (participant.clientId == session.controllerClientId ? ", session controller" : "")
                    )
                }

                if participants.isEmpty {
                    Text("Connecting participant presence…")
                        .font(.caption2)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }

                if !hasControl {
                    Button {
                        Task { await store.requestCodexControl(sessionID: session.id) }
                    } label: {
                        Label("Request control", systemImage: "hand.raised")
                    }
                    .buttonStyle(.plain)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                }
            }
            .padding(.horizontal, 16)
        }
        .frame(height: 42)
        .background(MobileFleetPalette.panel.opacity(0.95))
        .overlay(alignment: .bottom) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
    }

}

struct CodexComposerContext: Equatable {
    let status: CodexSessionStatus
    let permissionMode: FleetPermissionMode
    let model: String?
    let hasThread: Bool
    let controllerClientID: String?
    let deviceStatus: FleetDeviceStatus?
    let supportsCodexUIRPC: Bool
    let canInterrupt: Bool

    init(session: CodexSession, device: FleetDevice?) {
        status = session.status
        permissionMode = session.permissionMode
        model = session.model
        hasThread = session.threadId != nil
        controllerClientID = session.controllerClientId
        deviceStatus = device?.status
        supportsCodexUIRPC = device?.capabilities.labels.contains("feature:codex-ui-rpc") == true
        canInterrupt = session.turnId != nil && [.thinking, .awaitingApproval].contains(session.status)
    }
}

struct CodexComposer: View, @MainActor Equatable {
    @Environment(FleetStore.self) private var store
    let sessionID: String
    let context: CodexComposerContext
    let onMessageSent: () -> Void

    @SceneStorage private var draft: String
    @State private var isSending = false
    @State private var isInterrupting = false
    @State private var isChangingPermission = false
    @State private var presence = CodexTypingPresenceState()
    @State private var typingIdleTask: Task<Void, Never>?
    @State private var sendError: String?
    @State private var selectedMentionIndex = 0
    @FocusState private var composerFocused: Bool

    init(
        sessionID: String,
        context: CodexComposerContext,
        onMessageSent: @escaping () -> Void
    ) {
        self.sessionID = sessionID
        self.context = context
        self.onMessageSent = onMessageSent
        _draft = SceneStorage(wrappedValue: "", "fleet.codex.draft.\(sessionID)")
    }

    static func == (lhs: CodexComposer, rhs: CodexComposer) -> Bool {
        lhs.sessionID == rhs.sessionID && lhs.context == rhs.context
    }

    private var canSend: Bool {
        fleetChatDraftContainsSendableText(draft) &&
            !isSending &&
            mentionSuggestions.isEmpty &&
            context.deviceStatus != .offline &&
            [.ready, .completed, .thinking].contains(context.status)
    }

    private var canChangePermission: Bool {
        guard context.hasThread else { return false }
        guard context.controllerClientID == nil || context.controllerClientID == store.codexIdentity.clientId else {
            return false
        }
        if context.status == .stopped { return true }
        guard context.deviceStatus != .offline, context.supportsCodexUIRPC else { return false }
        return [.ready, .completed, .thinking, .awaitingApproval].contains(context.status)
    }

    private var mentionSuggestions: [FleetDeviceMentionSuggestion] {
        guard let active = fleetDeviceMentionQuery(in: draft) else { return [] }
        return fleetDeviceMentionSuggestions(devices: store.devices, query: active.query)
    }

    var body: some View {
        VStack(spacing: 9) {
            if context.status == .stopped {
                Button {
                    Task { await store.resumeSession(sessionID) }
                } label: {
                    Label("Resume session to continue", systemImage: "play.fill")
                }
                .buttonStyle(FleetSecondaryButtonStyle())
            }

            FleetDeviceMentionSuggestions(
                suggestions: mentionSuggestions,
                selectedIndex: selectedMentionIndex,
                select: insertMention
            )

            HStack(alignment: .bottom, spacing: 9) {
                FleetChatComposerInput(
                    placeholder: "Message Codex… Type @ for a fleet device",
                    accessibilityIdentifier: "codex-composer",
                    text: $draft,
                    focus: $composerFocused
                )

                if context.status == .thinking {
                    FleetChatStopButton(
                        isStopping: isInterrupting,
                        canStop: context.canInterrupt && !isInterrupting
                    ) {
                        Task { await interrupt() }
                    }
                }

                FleetChatSendButton(
                    isSending: isSending,
                    canSend: canSend,
                    accessibilityLabel: "Send message"
                ) {
                    Task { await send() }
                }
            }

            if let sendError {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                    Text(sendError)
                        .lineLimit(3)
                    Spacer(minLength: 0)
                }
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.red)
                .accessibilityIdentifier("codex-send-error")
            }

            HStack {
                Menu {
                    ForEach(FleetPermissionMode.allCases, id: \.rawValue) { permissionMode in
                        Button {
                            Task { await changePermission(to: permissionMode) }
                        } label: {
                            if permissionMode == context.permissionMode {
                                Label(permissionMode.displayName, systemImage: "checkmark")
                            } else {
                                Text(permissionMode.displayName)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        if isChangingPermission {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "lock.shield")
                        }
                        Text(context.permissionMode.displayName)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                }
                .disabled(!canChangePermission || isChangingPermission)
                .accessibilityLabel("Session permissions, \(context.permissionMode.displayName)")
                Spacer()
                if context.status == .thinking {
                    Text("Steering active turn")
                }
                if let model = context.model {
                    Text(model)
                }
            }
            .font(.caption2)
            .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
        .onChange(of: draft) {
            selectedMentionIndex = 0
            sendError = nil
            updateTypingPresence()
        }
        .task(id: sessionID) {
            await sendPresence(typing: false)
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    return
                }
                await sendPresence(typing: presence.isAdvertised)
            }
        }
        .onDisappear {
            typingIdleTask?.cancel()
            if presence.stop() {
                Task { await store.updateCodexPresence(sessionID: sessionID, typing: false) }
            }
        }
    }

    private func send() async {
        let text = draft
        guard fleetChatDraftContainsSendableText(text), !isSending, mentionSuggestions.isEmpty else { return }
        isSending = true
        draft = ""
        composerFocused = false
        sendError = nil
        typingIdleTask?.cancel()
        if presence.stop() {
            await sendPresence(typing: false)
        }
        let succeeded = await store.sendMessage(sessionID: sessionID, text: text)
        isSending = false
        if succeeded {
            onMessageSent()
        } else {
            sendError = store.lastError ?? "Orchestra could not send this message."
            draft = restoredFleetChatDraftAfterFailedSend(sent: text, current: draft)
            composerFocused = true
        }
    }

    private func interrupt() async {
        guard context.canInterrupt, !isInterrupting else { return }
        isInterrupting = true
        await store.interruptSession(sessionID)
        isInterrupting = false
    }

    private func changePermission(to permissionMode: FleetPermissionMode) async {
        guard permissionMode != context.permissionMode, !isChangingPermission else { return }
        isChangingPermission = true
        sendError = nil
        let succeeded = await store.updateSessionPermission(
            sessionID: sessionID,
            permissionMode: permissionMode
        )
        isChangingPermission = false
        if !succeeded {
            sendError = store.lastError ?? "Orchestra could not change this session's permissions."
        }
    }

    private func insertMention(_ suggestion: FleetDeviceMentionSuggestion) {
        draft = fleetInsertDeviceMention(suggestion, into: draft)
        selectedMentionIndex = 0
        composerFocused = true
    }

    private func updateTypingPresence() {
        typingIdleTask?.cancel()
        let hasText = fleetChatDraftContainsSendableText(draft)
        let transition = presence.update(hasText: hasText)

        if transition == .started {
            Task { await sendPresence(typing: true) }
        } else if transition == .stopped {
            Task { await sendPresence(typing: false) }
            return
        } else if !hasText {
            return
        }

        typingIdleTask = Task {
            do {
                try await Task.sleep(for: .seconds(3))
            } catch {
                return
            }
            guard presence.stop() else { return }
            await sendPresence(typing: false)
        }
    }

    private func sendPresence(typing: Bool) async {
        await store.updateCodexPresence(sessionID: sessionID, typing: typing)
    }
}

enum CodexTypingPresenceTransition: Equatable {
    case started
    case stopped
    case unchanged
}

struct CodexTypingPresenceState: Equatable {
    private(set) var isAdvertised = false

    mutating func update(hasText: Bool) -> CodexTypingPresenceTransition {
        if hasText, !isAdvertised {
            isAdvertised = true
            return .started
        }
        if !hasText, isAdvertised {
            isAdvertised = false
            return .stopped
        }
        return .unchanged
    }

    @discardableResult
    mutating func stop() -> Bool {
        guard isAdvertised else { return false }
        isAdvertised = false
        return true
    }
}

func normalizedFleetPath(_ value: String) -> String {
    var normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "\\", with: "/")
    while normalized.count > 1, normalized.hasSuffix("/") {
        normalized.removeLast()
    }
    return normalized.lowercased()
}

func codexProjectPathContainsSessionCWD(
    projectPath: String,
    sessionCWD: String
) -> Bool {
    let project = normalizedFleetPath(projectPath)
    let session = normalizedFleetPath(sessionCWD)
    guard project.count > 1 else { return session == project }
    return session == project || session.hasPrefix(project + "/")
}

func safeFleetPreviewURL(_ value: String) -> URL? {
    guard
        let url = URL(string: value),
        ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
        let host = url.host?.lowercased(),
        !["localhost", "127.0.0.1", "::1"].contains(host)
    else { return nil }

    if url.scheme?.lowercased() == "https" {
        return url
    }

    return isTailscaleAddress(host) ? url : nil
}

private func isTailscaleAddress(_ host: String) -> Bool {
    let octets = host.split(separator: ".").compactMap { Int($0) }
    if octets.count == 4 {
        return octets[0] == 100 && (64...127).contains(octets[1])
    }

    return host.lowercased().hasPrefix("fd7a:115c:a1e0:")
}

private extension String {
    var codexTailscaleSetupURL: URL? {
        components(separatedBy: .whitespacesAndNewlines)
            .compactMap { URL(string: $0.trimmingCharacters(in: .punctuationCharacters)) }
            .first { $0.scheme == "https" && $0.host == "login.tailscale.com" }
    }
}

struct NewCodexSessionView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(FleetStore.self) private var store

    let initialDeviceID: String?
    let onCreated: ((String) -> Void)?

    @State private var deviceID: String
    @State private var projectID = ""
    @State private var workingDirectory = ""
    @State private var title = "Codex session"
    @State private var permission: FleetPermissionMode = .workspaceWrite
    @State private var isSubmitting = false
    @State private var isBrowsingWorkspace = false

    init(
        initialDeviceID: String? = nil,
        onCreated: ((String) -> Void)? = nil
    ) {
        self.initialDeviceID = initialDeviceID
        self.onCreated = onCreated
        _deviceID = State(initialValue: initialDeviceID ?? "")
    }

    private var capableDevices: [FleetDevice] {
        store.devices.filter { $0.capabilities.codex && $0.status != .offline }
    }

    private var selectedDevice: FleetDevice? {
        store.devices.first { $0.id == deviceID }
    }

    private var selectedProject: FleetProject? {
        store.projects.first { $0.id == projectID }
    }

    private var canSubmit: Bool {
        !deviceID.isEmpty &&
            !workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Execution context") {
                    Picker("Device", selection: $deviceID) {
                        Text("Select a device").tag("")
                        ForEach(capableDevices) { device in
                            Text("\(device.name) · \(device.role.displayName)").tag(device.id)
                        }
                    }

                    Picker("Project", selection: $projectID) {
                        Text("No project").tag("")
                        ForEach(store.projects) { project in
                            Text(project.name).tag(project.id)
                        }
                    }

                    HStack(spacing: 8) {
                        TextField("Working directory", text: $workingDirectory)
                            .font(.body.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            isBrowsingWorkspace = true
                        } label: {
                            Label("Browse", systemImage: "folder")
                        }
                        .buttonStyle(.bordered)
                        .disabled(selectedDevice == nil)
                    }
                }
                .listRowBackground(MobileFleetPalette.panel)

                Section("Session") {
                    TextField("Session title", text: $title)

                    Picker("Permissions", selection: $permission) {
                        ForEach(FleetPermissionMode.allCases, id: \.self) { mode in
                            Text(mode.displayName).tag(mode)
                        }
                    }
                }
                .listRowBackground(MobileFleetPalette.panel)

                if capableDevices.isEmpty {
                    Section {
                        Label(
                            "No online Codex-capable devices are available.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .foregroundStyle(MobileFleetPalette.amber)
                    }
                    .listRowBackground(MobileFleetPalette.amber.opacity(0.08))
                }

                if permission == .dangerFullAccess {
                    Section {
                        Label(
                            "Full access removes the workspace sandbox on the selected device.",
                            systemImage: "exclamationmark.shield.fill"
                        )
                        .font(.footnote)
                        .foregroundStyle(MobileFleetPalette.amber)
                    }
                    .listRowBackground(MobileFleetPalette.amber.opacity(0.08))
                }

                if let error = store.lastError {
                    Section {
                        FleetInlineError(message: error)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            .scrollContentBackground(.hidden)
            .background(MobileFleetPalette.background)
            .navigationTitle("New Codex Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .frame(minHeight: 44)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Starting…" : "Start") {
                        Task { await submit() }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSubmit)
                    .frame(minHeight: 44)
                }
            }
            .onAppear {
                if deviceID.isEmpty, capableDevices.count == 1 {
                    deviceID = capableDevices[0].id
                }
                updateWorkingDirectory()
            }
            .onChange(of: deviceID) { updateWorkingDirectory() }
            .onChange(of: projectID) { updateWorkingDirectory() }
            .sheet(isPresented: $isBrowsingWorkspace) {
                if let selectedDevice {
                    CodexWorkspacePickerView(
                        device: selectedDevice,
                        initialPath: workingDirectory
                    ) { path in
                        workingDirectory = path
                    }
                }
            }
            .fleetMobileBackground()
        }
    }

    private func updateWorkingDirectory() {
        workingDirectory = preferredCodexWorkingDirectory(
            deviceID: deviceID,
            projectPaths: selectedProject?.paths,
            deviceProjectRoots: selectedDevice?.projectRoots ?? []
        )
    }

    private func submit() async {
        isSubmitting = true
        let request = CreateCodexSessionRequest(
            deviceId: deviceID,
            projectId: projectID.isEmpty ? nil : projectID,
            cwd: workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines),
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            permissionMode: permission,
            approvalPolicy: .onRequest
        )
        let session = await store.createSession(request)
        isSubmitting = false
        if let session {
            onCreated?(session.id)
            dismiss()
        }
    }
}

private struct CodexWorkspacePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(FleetStore.self) private var store

    let device: FleetDevice
    let onChoose: (String) -> Void

    @State private var rootPath: String
    @State private var rootBoundary: String
    @State private var currentPath: String
    @State private var listing: FleetWorkspacePage?
    @State private var errorMessage: String?
    @State private var pageError: String?
    @State private var isLoadingMore = false
    @State private var isCreatingFolder = false
    @State private var folderName = ""
    @State private var isCreating = false
    @State private var revision = 0

    init(
        device: FleetDevice,
        initialPath: String,
        onChoose: @escaping (String) -> Void
    ) {
        self.device = device
        self.onChoose = onChoose
        let root = device.projectRoots
            .filter { fleetWorkspacePath(initialPath, isWithin: $0) }
            .max(by: { $0.count < $1.count })
            ?? device.projectRoots.first
            ?? ""
        _rootPath = State(initialValue: root)
        _rootBoundary = State(initialValue: root)
        _currentPath = State(initialValue: fleetWorkspacePath(initialPath, isWithin: root) ? initialPath : root)
    }

    private var effectivePath: String {
        listing?.path ?? currentPath
    }

    private var parentPath: String? {
        fleetWorkspaceParent(of: effectivePath, root: rootBoundary)
    }

    var body: some View {
        NavigationStack {
            Form {
                if device.projectRoots.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "No Workspace Roots",
                            systemImage: "externaldrive.badge.exclamationmark",
                            description: Text("Add a local folder or mounted NAS path to this device's Agent project roots, then reconnect the Agent.")
                        )
                    }
                    .listRowBackground(Color.clear)
                } else {
                    Section("Available root") {
                        Picker("Root", selection: $rootPath) {
                            ForEach(device.projectRoots, id: \.self) { root in
                                Text(root).tag(root)
                            }
                        }
                        .font(.body.monospaced())

                        HStack(spacing: 10) {
                            Button {
                                if let parentPath {
                                    currentPath = parentPath
                                }
                            } label: {
                                Image(systemName: "chevron.left")
                            }
                            .disabled(parentPath == nil)

                            Image(systemName: "folder.fill")
                                .foregroundStyle(MobileFleetPalette.cyan)
                            Text(effectivePath)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 0)
                            Button {
                                revision += 1
                            } label: {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                    }
                    .listRowBackground(MobileFleetPalette.panel)

                    if isCreatingFolder {
                        Section("New folder") {
                            TextField("Folder name", text: $folderName)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .onSubmit { Task { await createFolder() } }
                            HStack {
                                Button("Cancel") {
                                    isCreatingFolder = false
                                    folderName = ""
                                }
                                Spacer()
                                Button(isCreating ? "Creating…" : "Create & Open") {
                                    Task { await createFolder() }
                                }
                                .disabled(isCreating || !fleetWorkspaceFolderNameIsValid(folderName))
                            }
                        }
                        .listRowBackground(MobileFleetPalette.panel)
                    }

                    Section("Contents") {
                        if let errorMessage {
                            VStack(alignment: .leading, spacing: 9) {
                                Label("Folder unavailable", systemImage: "externaldrive.badge.exclamationmark")
                                    .font(.headline)
                                Text(errorMessage)
                                    .font(.footnote)
                                    .foregroundStyle(MobileFleetPalette.mutedText)
                                Button("Retry") { revision += 1 }
                            }
                        } else if let listing {
                            if listing.entries.isEmpty {
                                ContentUnavailableView(
                                    "Empty Folder",
                                    systemImage: "folder",
                                    description: Text("Create a folder here or use this folder directly.")
                                )
                            } else {
                                ForEach(listing.entries) { entry in
                                    Button {
                                        currentPath = entry.path
                                    } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: entry.type == .directory ? "folder.fill" : "doc")
                                                .foregroundStyle(entry.type == .directory ? MobileFleetPalette.cyan : MobileFleetPalette.mutedText)
                                                .frame(width: 22)
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(entry.name)
                                                    .foregroundStyle(MobileFleetPalette.primaryText)
                                                Text(entry.type == .directory ? "Folder" : entry.type.rawValue.capitalized)
                                                    .font(.caption)
                                                    .foregroundStyle(MobileFleetPalette.mutedText)
                                            }
                                            Spacer()
                                            if entry.type == .directory {
                                                Image(systemName: "chevron.right")
                                                    .font(.caption)
                                                    .foregroundStyle(MobileFleetPalette.mutedText)
                                            }
                                        }
                                    }
                                    .disabled(entry.type != .directory)
                                }
                            }

                            if listing.nextCursor != nil || pageError != nil {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Showing \(listing.entries.count) of \(listing.total)")
                                        .font(.caption)
                                        .foregroundStyle(MobileFleetPalette.mutedText)
                                    if let pageError {
                                        Text(pageError)
                                            .font(.caption)
                                            .foregroundStyle(MobileFleetPalette.red)
                                    }
                                    if listing.nextCursor != nil {
                                        Button(isLoadingMore ? "Loading…" : "Load More") {
                                            Task { await loadMore() }
                                        }
                                        .disabled(isLoadingMore)
                                    }
                                }
                            }
                        } else {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Reading \(device.name)…")
                                    .foregroundStyle(MobileFleetPalette.mutedText)
                            }
                        }
                    }
                    .listRowBackground(MobileFleetPalette.panel)

                    Section {
                        Label(
                            "A mounted SMB/NFS share is available here when its mount path is included in this device's Agent project roots.",
                            systemImage: "externaldrive.connected.to.line.below"
                        )
                        .font(.footnote)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                    }
                    .listRowBackground(MobileFleetPalette.panel)
                }
            }
            .scrollContentBackground(.hidden)
            .background(MobileFleetPalette.background)
            .navigationTitle("Choose Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isCreatingFolder = true
                    } label: {
                        Label("New Folder", systemImage: "folder.badge.plus")
                    }
                    .disabled(device.projectRoots.isEmpty || listing == nil)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use Folder") {
                        onChoose(effectivePath)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(listing == nil || errorMessage != nil)
                }
            }
            .onChange(of: rootPath) {
                rootBoundary = rootPath
                currentPath = rootPath
                listing = nil
                errorMessage = nil
            }
            .task(id: "\(currentPath)\u{0}\(revision)") {
                await loadDirectory()
            }
            .fleetMobileBackground()
        }
    }

    private func loadDirectory() async {
        guard !currentPath.isEmpty else { return }
        let requestedPath = currentPath
        listing = nil
        errorMessage = nil
        pageError = nil
        do {
            let page = try await store.deviceWorkspace(deviceID: device.id, path: requestedPath)
            guard !Task.isCancelled else { return }
            listing = page
            if fleetWorkspacePathsAreEqual(requestedPath, rootPath) {
                rootBoundary = page.path
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let listing, let cursor = listing.nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        pageError = nil
        defer { isLoadingMore = false }
        do {
            let page = try await store.deviceWorkspace(deviceID: device.id, path: listing.path, cursor: cursor)
            var entries = Dictionary(uniqueKeysWithValues: listing.entries.map { ($0.path, $0) })
            for entry in page.entries { entries[entry.path] = entry }
            self.listing = FleetWorkspacePage(
                path: page.path,
                entries: entries.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending },
                nextCursor: page.nextCursor,
                total: max(page.total, entries.count)
            )
        } catch {
            pageError = error.localizedDescription
        }
    }

    private func createFolder() async {
        let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard fleetWorkspaceFolderNameIsValid(name), !isCreating else { return }
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            let result = try await store.createDeviceWorkspaceDirectory(
                deviceID: device.id,
                path: fleetWorkspaceJoin(effectivePath, name)
            )
            folderName = ""
            isCreatingFolder = false
            listing = nil
            currentPath = result.path
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct CodexSessionNavigationState: Equatable {
    private(set) var pendingCreatedSessionID: String?
    private(set) var presentedSessionID: String?

    mutating func recordCreatedSession(_ id: String) {
        pendingCreatedSessionID = id
    }

    mutating func presentPendingSession() {
        presentedSessionID = pendingCreatedSessionID
        pendingCreatedSessionID = nil
    }

    mutating func dismissPresentedSession() {
        presentedSessionID = nil
    }
}

func preferredCodexWorkingDirectory(
    deviceID: String,
    projectPaths: [FleetProjectPath]?,
    deviceProjectRoots: [String]
) -> String {
    projectPaths?.first(where: { $0.deviceId == deviceID })?.path
        ?? deviceProjectRoots.first
        ?? ""
}

func fleetWorkspacePath(_ candidate: String, isWithin root: String) -> Bool {
    let path = fleetWorkspaceNormalizedPath(candidate)
    let boundary = fleetWorkspaceNormalizedPath(root)
    guard !path.isEmpty, !boundary.isEmpty else { return false }
    if path == boundary { return true }
    return boundary == "/" ? path.hasPrefix("/") : path.hasPrefix("\(boundary)/")
}

func fleetWorkspacePathsAreEqual(_ left: String, _ right: String) -> Bool {
    fleetWorkspacePath(left, isWithin: right) && fleetWorkspacePath(right, isWithin: left)
}

func fleetWorkspaceJoin(_ parent: String, _ child: String) -> String {
    let separator = parent.contains("\\") && !parent.contains("/") ? "\\" : "/"
    var base = parent
    while base.count > 1, base.last == "/" || base.last == "\\" {
        base.removeLast()
    }
    return base == "/" ? "/\(child)" : "\(base)\(separator)\(child)"
}

func fleetWorkspaceParent(of candidate: String, root: String) -> String? {
    guard fleetWorkspacePath(candidate, isWithin: root), !fleetWorkspacePathsAreEqual(candidate, root) else {
        return nil
    }
    var value = candidate
    while value.count > 1, value.last == "/" || value.last == "\\" {
        value.removeLast()
    }
    guard let separatorIndex = value.lastIndex(where: { $0 == "/" || $0 == "\\" }) else {
        return root
    }
    let separator = value[separatorIndex]
    var parent = String(value[..<separatorIndex])
    if parent.isEmpty, value.first == "/" { parent = "/" }
    if parent.count == 2, parent.last == ":" { parent.append(separator) }
    return fleetWorkspacePath(parent, isWithin: root) ? parent : root
}

func fleetWorkspaceFolderNameIsValid(_ value: String) -> Bool {
    let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return !name.isEmpty && name != "." && name != ".." &&
        !name.contains("/") && !name.contains("\\") &&
        !name.unicodeScalars.contains(where: { $0.value == 0 })
}

private func fleetWorkspaceNormalizedPath(_ value: String) -> String {
    let converted = value.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\", with: "/")
    let prefix = converted.hasPrefix("//") ? "//" : converted.hasPrefix("/") ? "/" : ""
    let components = converted.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    var normalized = prefix + components.joined(separator: "/")
    if normalized.isEmpty, prefix == "/" { normalized = "/" }
    if components.first?.last == ":" {
        normalized = normalized.lowercased()
    }
    return normalized
}

private struct CodexSummaryStat: View {
    let value: String
    let label: String
    let tone: FleetMobileTone

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(tone.color)
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

struct CodexSessionCard: View {
    let session: CodexSession
    let device: FleetDevice?
    let project: FleetProject?

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(MobileFleetPalette.purple)
                        .frame(width: 42, height: 42)
                        .background(MobileFleetPalette.purple.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title)
                            .font(.headline.weight(.semibold))
                            .lineLimit(1)
                        Text(device?.name ?? "Unknown device")
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }

                    Spacer(minLength: 4)
                    FleetMobileStatusPill(text: session.status.displayName, tone: session.status.tone)
                }

                Text(session.events.last(where: { $0.type == .assistant || $0.type == .user })?.text ?? "No messages yet")
                    .font(.subheadline)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .lineLimit(2)

                HStack(spacing: 10) {
                    if let project {
                        Label(project.name, systemImage: "folder")
                    } else {
                        Label(URL(fileURLWithPath: session.cwd).lastPathComponent, systemImage: "folder")
                    }
                    if !session.pendingApprovals.isEmpty {
                        Label("\(session.pendingApprovals.count)", systemImage: "checkmark.shield")
                            .foregroundStyle(MobileFleetPalette.amber)
                    }
                    Spacer()
                    Text(session.updatedAt, style: .relative)
                }
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens Codex conversation")
    }
}

private struct CodexEventBubble: View, @MainActor Equatable {
    let event: CodexEvent
    let sessionID: String
    let sources: [CodexMessageSource]
    let canBranch: Bool
    let onBranch: (String) -> Void

    static func == (lhs: CodexEventBubble, rhs: CodexEventBubble) -> Bool {
        lhs.event.id == rhs.event.id &&
            lhs.event.at == rhs.event.at &&
            lhs.event.type == rhs.event.type &&
            lhs.event.text == rhs.event.text &&
            lhs.event.actor == rhs.event.actor &&
            lhs.sessionID == rhs.sessionID &&
            lhs.sources == rhs.sources &&
            lhs.canBranch == rhs.canBranch
    }

    var body: some View {
        switch event.type {
        case .user, .assistant:
            messageBubble
        case .reasoning, .plan:
            processCard(icon: event.type == .plan ? "list.bullet.clipboard" : "brain.head.profile", tone: .purple)
        case .command:
            processCard(icon: "terminal", tone: .cyan, monospaced: true)
        case .file:
            processCard(icon: "doc.badge.gearshape", tone: .green)
        case .tool:
            processCard(icon: "wrench.and.screwdriver", tone: .cyan)
        case .status:
            processCard(icon: "waveform.path.ecg", tone: .neutral)
        case .error:
            processCard(icon: "exclamationmark.triangle.fill", tone: .red)
        case .raw:
            EmptyView()
        }
    }

    private var messageBubble: some View {
        HStack {
            if event.type == .user { Spacer(minLength: 48) }

            VStack(alignment: .leading, spacing: 6) {
                Text(event.type == .user ? "You" : "Codex")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(event.type == .user ? MobileFleetPalette.cyanBright : MobileFleetPalette.purple)
                if event.type == .user, let actor = event.actor {
                    Text("\(actor.name) · \(actor.deviceName)")
                        .font(.caption2)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }
                FleetMarkdownText(text: event.text)
                Text(event.at, style: .time)
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                CodexMessageActionBar(
                    event: event,
                    sessionID: sessionID,
                    sources: sources,
                    canBranch: canBranch,
                    onBranch: onBranch
                )
            }
            .padding(13)
            .background(
                event.type == .user
                    ? MobileFleetPalette.cyan.opacity(0.11)
                    : MobileFleetPalette.panel,
                in: RoundedRectangle(cornerRadius: 17, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .stroke(
                        event.type == .user
                            ? MobileFleetPalette.cyan.opacity(0.32)
                            : MobileFleetPalette.border,
                        lineWidth: 1
                    )
            }

            if event.type == .assistant { Spacer(minLength: 20) }
        }
        .accessibilityElement(children: .contain)
    }

    private func processCard(icon: String, tone: FleetMobileTone, monospaced: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tone.color)
                .frame(width: 28, height: 28)
                .background(tone.color.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(event.type.rawValue.capitalized)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(tone.color)
                if monospaced {
                    Text(event.text)
                        .font(.caption.monospaced())
                        .foregroundStyle(MobileFleetPalette.secondaryText)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    FleetMarkdownText(text: event.text, compact: true)
                        .foregroundStyle(MobileFleetPalette.secondaryText)
                }
            }
            Spacer(minLength: 4)
        }
        .padding(11)
        .background(MobileFleetPalette.panel.opacity(0.72), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(MobileFleetPalette.softBorder, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct CodexMessageActionBar: View {
    @Environment(FleetStore.self) private var store
    @Environment(\.openURL) private var openURL
    let event: CodexEvent
    let sessionID: String
    let sources: [CodexMessageSource]
    let canBranch: Bool
    let onBranch: (String) -> Void

    @State private var copied = false
    @State private var branching = false

    var body: some View {
        HStack(spacing: 2) {
            Button {
                UIPasteboard.general.string = event.text
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.4))
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .accessibilityLabel(copied ? "Message copied" : "Copy message")

            if event.type == .assistant {
                Button {
                    branching = true
                    Task {
                        if let branched = await store.forkSession(sessionID, from: event) {
                            onBranch(branched.id)
                        }
                        branching = false
                    }
                } label: {
                    Label(branching ? "Branching…" : "Branch", systemImage: "arrow.triangle.branch")
                }
                .disabled(!canBranch || branching)
                .accessibilityLabel("Branch in new chat")
            }

            if !sources.isEmpty {
                Menu {
                    ForEach(sources) { source in
                        if let url = source.url {
                            Button {
                                openURL(url)
                            } label: {
                                Label(source.title, systemImage: "arrow.up.right.square")
                            }
                        } else {
                            Text("Search: \(source.title)")
                        }
                    }
                } label: {
                    Label("Sources", systemImage: "books.vertical")
                }
                .accessibilityLabel("Show web sources")
            }

            Spacer(minLength: 0)
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(MobileFleetPalette.mutedText)
        .labelStyle(.titleAndIcon)
        .buttonStyle(.plain)
        .padding(.top, 4)
        .overlay(alignment: .top) {
            Divider().overlay(MobileFleetPalette.softBorder.opacity(0.7))
        }
    }
}

struct CodexMessageSource: Identifiable, Sendable, Hashable {
    let title: String
    let url: URL?

    var id: String { url?.absoluteString ?? "query:\(title.lowercased())" }
}

func codexEventTurnID(_ event: CodexEvent) -> String? {
    codexJSONString(forKey: "turnId", in: event.data)
        ?? codexJSONString(forKey: "id", under: "turn", in: event.data)
}

func codexMessageSources(for assistant: CodexEvent, in events: [CodexEvent]) -> [CodexMessageSource] {
    guard assistant.type == .assistant,
          let assistantIndex = events.firstIndex(where: { $0.id == assistant.id }) else { return [] }
    let turnID = codexEventTurnID(assistant)
    var start = assistantIndex - 1
    while start >= 0, ![.user, .assistant].contains(events[start].type) { start -= 1 }
    let searches = events[max(0, start)..<assistantIndex].filter { event in
        guard event.type == .tool else { return false }
        let isSearch = codexJSONString(forKey: "type", in: event.data) == "webSearch"
            || event.text.lowercased().hasPrefix("web search")
        let searchTurnID = codexEventTurnID(event)
        return isSearch && (turnID == nil || searchTurnID == nil || searchTurnID == turnID)
    }
    guard !searches.isEmpty else { return [] }

    var sources = codexMarkdownSources(in: assistant.text)
    for search in searches { codexCollectSourceURLs(from: search.data, into: &sources) }
    if sources.isEmpty {
        sources = searches.compactMap { event in
            let query = codexJSONString(forKey: "query", in: event.data)
                ?? event.text.split(separator: "—", maxSplits: 1).last.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return query.flatMap { $0.isEmpty ? nil : CodexMessageSource(title: $0, url: nil) }
        }
    }
    var seen = Set<String>()
    return sources.filter { seen.insert($0.id).inserted }
}

private func codexMarkdownSources(in text: String) -> [CodexMessageSource] {
    let pattern = #"\[([^\]]+)\]\((https?://[^\s\)]+)(?:\s+[\"'][^\"']*[\"'])?\)"#
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..., in: text)
    return expression.matches(in: text, range: range).compactMap { match in
        guard let titleRange = Range(match.range(at: 1), in: text),
              let urlRange = Range(match.range(at: 2), in: text),
              let url = URL(string: String(text[urlRange])) else { return nil }
        return CodexMessageSource(title: String(text[titleRange]), url: url)
    }
}

private func codexCollectSourceURLs(from value: JSONValue?, into sources: inout [CodexMessageSource], depth: Int = 0) {
    guard depth <= 7, let value else { return }
    switch value {
    case let .array(values):
        for entry in values { codexCollectSourceURLs(from: entry, into: &sources, depth: depth + 1) }
    case let .object(object):
        for key in ["url", "uri", "href"] {
            guard let urlString = object[key]?.stringValue,
                  let url = URL(string: urlString),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
            let title = object["title"]?.stringValue ?? object["name"]?.stringValue ?? url.host ?? "Source"
            sources.append(CodexMessageSource(title: title, url: url))
        }
        for entry in object.values { codexCollectSourceURLs(from: entry, into: &sources, depth: depth + 1) }
    default:
        break
    }
}

private func codexJSONString(forKey key: String, under parentKey: String? = nil, in value: JSONValue?, depth: Int = 0) -> String? {
    guard depth <= 6, let value else { return nil }
    switch value {
    case let .array(values):
        for entry in values {
            if let found = codexJSONString(forKey: key, under: parentKey, in: entry, depth: depth + 1) { return found }
        }
    case let .object(object):
        if parentKey == nil, let found = object[key]?.stringValue { return found }
        if let parentKey, let found = object[parentKey]?[key]?.stringValue { return found }
        for entry in object.values {
            if let found = codexJSONString(forKey: key, under: parentKey, in: entry, depth: depth + 1) { return found }
        }
    default:
        break
    }
    return nil
}

private struct CodexThinkingRow: View {
    let status: CodexSessionStatus

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .tint(MobileFleetPalette.cyan)
            Text(status == .starting ? "Starting Codex on the remote device…" : "Codex is working…")
                .font(.subheadline)
                .foregroundStyle(MobileFleetPalette.secondaryText)
            Spacer()
        }
        .padding(13)
        .background(MobileFleetPalette.cyan.opacity(0.06), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct CodexInlineApproval: View {
    @Environment(FleetStore.self) private var store
    let approval: CodexApproval
    let menuApproval: FleetMenuApproval?

    @State private var responding = false

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.title3)
                        .foregroundStyle(MobileFleetPalette.amber)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Approval required")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(MobileFleetPalette.amber)
                        Text(approval.title)
                            .font(.headline.weight(.semibold))
                    }
                }

                Text(approval.detail)
                    .font(.subheadline)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 9) {
                    Button {
                        respond(.decline)
                    } label: {
                        Text("Decline")
                    }
                    .buttonStyle(FleetSecondaryButtonStyle())

                    Button {
                        respond(.accept)
                    } label: {
                        Text(responding ? "Approving…" : "Approve Once")
                    }
                    .buttonStyle(FleetPrimaryButtonStyle())
                    .disabled(responding || menuApproval == nil)
                }
            }
        }
    }

    private func respond(_ decision: ApprovalDecision) {
        guard let menuApproval else { return }
        responding = true
        Task {
            await store.respond(to: menuApproval, decision: decision)
            responding = false
        }
    }
}

extension CodexSessionStatus {
    var fleetTone: FleetTone {
        switch self {
        case .starting, .thinking: .blue
        case .ready, .completed: .healthy
        case .awaitingApproval: .warning
        case .error: .critical
        case .stopped: .neutral
        }
    }
}
