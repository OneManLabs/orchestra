import SwiftUI

struct FleetSystemView: View {
    @Environment(FleetStore.self) private var store
    @State private var isResetting = false
    @State private var selectedConversationID: String?
    @State private var showClearConfirmation = false
    @State private var scrollRequest = 0

    private var activeConversation: FleetSystemConversation? {
        store.systemConversation
    }

    private var conversations: [FleetSystemConversation] {
        if store.systemConversations.isEmpty, let activeConversation {
            return [activeConversation]
        }
        return store.systemConversations
    }

    private var conversation: FleetSystemConversation? {
        guard let selectedConversationID else { return activeConversation }
        return conversations.first { $0.id == selectedConversationID } ?? activeConversation
    }

    private var isViewingHistory: Bool {
        guard let conversation, let activeConversation else { return false }
        return conversation.id != activeConversation.id
    }

    private var orchestrator: FleetDevice? {
        guard let id = conversation?.orchestratorDeviceId ?? store.snapshot?.settings.systemOrchestratorDeviceId else {
            return store.devices.first { $0.role == .core }
        }
        return store.devices.first { $0.id == id }
    }

    var body: some View {
        VStack(spacing: 0) {
            systemHost
            conversationToolbar

            if let conversation {
                ScrollView {
                    LazyVStack(spacing: 14) {
                        ForEach(conversation.messages) { message in
                            let plan = conversation.conductorPlans?.first { $0.id == message.conductorPlanId }
                            let firstPlanMessageID = plan.flatMap { plan in
                                conversation.messages.first { $0.conductorPlanId == plan.id }?.id
                            }
                            FleetSystemMessageBubble(
                                message: message,
                                pendingAction: conversation.pendingActions.first { $0.id == message.pendingActionId },
                                conductorPlan: firstPlanMessageID == message.id ? plan : nil,
                                canConfirm: !isViewingHistory,
                                confirm: { action in
                                    Task { await store.confirmSystemPowerAction(action) }
                                }
                            )
                            .equatable()
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 16)
                }
                .fleetChatTranscriptBehavior(scrollRequest: scrollRequest, contentVersion: conversation.updatedAt)
            } else {
                FleetMobileEmptyState(
                    icon: "server.rack",
                    title: "Orchestra System is connecting",
                    message: "The Core-owned system conversation will appear with the next fleet snapshot."
                )
                Spacer()
            }

            if isViewingHistory {
                historyBar
            } else {
                FleetSystemComposer(
                    conversationID: activeConversation?.id,
                    onMessageSent: requestScrollToBottom
                )
                    .id(activeConversation?.id ?? "fleet-system-active")
            }
        }
        .navigationTitle("Orchestra System")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .confirmationDialog(
            "Clear this Orchestra System conversation?",
            isPresented: $showClearConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear conversation", role: .destructive) {
                Task { await clearConversation() }
            }
        } message: {
            Text("This permanently removes the active messages and resets the underlying Codex context.")
        }
        .fleetMobileBackground()
    }

    private var systemHost: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(MobileFleetPalette.cyan.opacity(0.12))
                Image(systemName: "sparkles")
                    .foregroundStyle(MobileFleetPalette.cyanBright)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 2) {
                Text("CORE-OWNED ORCHESTRATION")
                    .font(.caption2.weight(.bold))
                    .tracking(0.7)
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                Text(orchestrator.map { "Hosted by \($0.name)" } ?? "Waiting for Core host")
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
            }
            Spacer()
            Circle()
                .fill(orchestrator?.status == .offline ? MobileFleetPalette.mutedText : MobileFleetPalette.green)
                .frame(width: 8, height: 8)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(MobileFleetPalette.panel.opacity(0.96))
        .overlay(alignment: .bottom) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
    }

    private var conversationToolbar: some View {
        HStack(spacing: 9) {
            Menu {
                ForEach(conversations) { item in
                    Button {
                        selectedConversationID = item.id == activeConversation?.id ? nil : item.id
                    } label: {
                        Label(
                            systemConversationLabel(item),
                            systemImage: item.id == conversation?.id ? "checkmark" : (item.id == activeConversation?.id ? "message.fill" : "archivebox")
                        )
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isViewingHistory ? "archivebox" : "message.fill")
                        .foregroundStyle(MobileFleetPalette.cyanBright)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(conversation.map(systemConversationLabel) ?? "Orchestra System")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(MobileFleetPalette.primaryText)
                            .lineLimit(1)
                        Text(isViewingHistory ? "Conversation history" : "Current conversation")
                            .font(.caption2)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(MobileFleetPalette.raisedPanel, in: RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(MobileFleetPalette.border, lineWidth: 1)
                }
            }
            .disabled(conversations.isEmpty)

            Button {
                showClearConfirmation = true
            } label: {
                Image(systemName: "trash")
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .foregroundStyle(MobileFleetPalette.secondaryText)
            .disabled(
                isResetting
                    || isViewingHistory
                    || activeConversation?.messages.isEmpty != false
                    || activeConversation?.activeResponseMessageId != nil
            )
            .accessibilityLabel("Clear active Orchestra System conversation")

            Button {
                Task { await newConversation() }
            } label: {
                Label("New", systemImage: "plus")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .frame(height: 34)
            }
            .buttonStyle(.plain)
            .foregroundStyle(MobileFleetPalette.primaryText)
            .background(MobileFleetPalette.raisedPanel, in: RoundedRectangle(cornerRadius: 9))
            .overlay {
                RoundedRectangle(cornerRadius: 9)
                    .stroke(MobileFleetPalette.border, lineWidth: 1)
            }
            .disabled(isResetting || activeConversation?.activeResponseMessageId != nil)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(MobileFleetPalette.panel.opacity(0.94))
        .overlay(alignment: .bottom) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
    }

    private var historyBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "archivebox")
                .foregroundStyle(MobileFleetPalette.cyanBright)
            VStack(alignment: .leading, spacing: 2) {
                Text("Conversation history")
                    .font(.caption.weight(.semibold))
                Text("This preserved chat is read-only.")
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }
            Spacer()
            Button("Current") {
                selectedConversationID = nil
            }
            .buttonStyle(FleetSecondaryButtonStyle())
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
    }

    private func newConversation() async {
        guard !isResetting, activeConversation?.activeResponseMessageId == nil else { return }
        isResetting = true
        let succeeded = await store.newSystemConversation()
        isResetting = false
        if succeeded {
            selectedConversationID = nil
        }
    }

    private func clearConversation() async {
        guard !isResetting, !isViewingHistory, activeConversation?.activeResponseMessageId == nil else { return }
        isResetting = true
        let succeeded = await store.clearSystemConversation()
        isResetting = false
        if succeeded {
            selectedConversationID = nil
        }
    }

    private func requestScrollToBottom() {
        scrollRequest &+= 1
    }
}

struct FleetSystemComposer: View, @MainActor Equatable {
    @Environment(FleetStore.self) private var store
    let conversationID: String?
    let onMessageSent: () -> Void

    @SceneStorage private var draft: String
    @State private var isSending = false
    @State private var selectedMentionIndex = 0
    @State private var conductorMode = false
    @FocusState private var composerFocused: Bool

    init(conversationID: String?, onMessageSent: @escaping () -> Void) {
        self.conversationID = conversationID
        self.onMessageSent = onMessageSent
        _draft = SceneStorage(
            wrappedValue: "",
            "fleet.system.draft.\(conversationID ?? "active")"
        )
    }

    static func == (lhs: FleetSystemComposer, rhs: FleetSystemComposer) -> Bool {
        lhs.conversationID == rhs.conversationID
    }

    private var mentionSuggestions: [FleetDeviceMentionSuggestion] {
        guard let active = fleetDeviceMentionQuery(in: draft) else { return [] }
        return fleetDeviceMentionSuggestions(devices: store.devices, query: active.query)
    }

    private var canSend: Bool {
        fleetChatDraftContainsSendableText(draft) &&
            !isSending &&
            mentionSuggestions.isEmpty
    }

    var body: some View {
        VStack(spacing: 8) {
            FleetDeviceMentionSuggestions(
                suggestions: mentionSuggestions,
                selectedIndex: selectedMentionIndex,
                select: insertMention
            )

            HStack {
                Button {
                    conductorMode.toggle()
                } label: {
                    Label("Conductor", systemImage: "wand.and.stars")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(conductorMode ? MobileFleetPalette.purple : MobileFleetPalette.secondaryText)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(
                            (conductorMode ? MobileFleetPalette.purple.opacity(0.14) : MobileFleetPalette.raisedPanel),
                            in: Capsule()
                        )
                        .overlay { Capsule().stroke(conductorMode ? MobileFleetPalette.purple.opacity(0.6) : MobileFleetPalette.border, lineWidth: 1) }
                }
                .buttonStyle(.plain)
                Spacer()
                Text(conductorMode ? "Review a plan before anything runs" : "Chat normally")
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }

            HStack(alignment: .bottom, spacing: 9) {
                FleetChatComposerInput(
                    placeholder: conductorMode ? "Describe the outcome…" : "Ask Orchestra System… Type @ for a device",
                    accessibilityIdentifier: "fleet-system-composer",
                    text: $draft,
                    focus: $composerFocused
                )

                FleetChatSendButton(
                    isSending: isSending,
                    canSend: canSend,
                    accessibilityLabel: "Send to Orchestra System"
                ) {
                    Task { await send() }
                }
            }

            HStack {
                Text(conductorMode ? "Plan · review · approve · dispatch" : "@device telemetry · Codex orchestration · confirmed controls")
                Spacer()
                Text("Owned by Core")
            }
            .font(.caption2)
            .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .padding(.horizontal, 12)
        .padding(.top, 9)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Divider().overlay(MobileFleetPalette.softBorder)
        }
        .onChange(of: draft) {
            selectedMentionIndex = 0
        }
    }

    private func insertMention(_ suggestion: FleetDeviceMentionSuggestion) {
        draft = fleetInsertDeviceMention(suggestion, into: draft)
        selectedMentionIndex = 0
        composerFocused = true
    }

    private func send() async {
        let text = draft
        guard fleetChatDraftContainsSendableText(text), !isSending, mentionSuggestions.isEmpty else { return }
        isSending = true
        draft = ""
        composerFocused = false
        let succeeded = await store.sendSystemMessage(text, mode: conductorMode ? "conductor" : "chat")
        isSending = false
        if succeeded {
            onMessageSent()
        } else {
            draft = restoredFleetChatDraftAfterFailedSend(sent: text, current: draft)
            composerFocused = true
        }
    }
}

private struct FleetSystemMessageBubble: View, @MainActor Equatable {
    let message: FleetSystemMessage
    let pendingAction: FleetSystemPendingAction?
    let conductorPlan: FleetConductorPlan?
    let canConfirm: Bool
    let confirm: (FleetSystemPendingAction) -> Void

    static func == (lhs: FleetSystemMessageBubble, rhs: FleetSystemMessageBubble) -> Bool {
        lhs.message == rhs.message &&
            lhs.pendingAction == rhs.pendingAction &&
            lhs.conductorPlan == rhs.conductorPlan &&
            lhs.canConfirm == rhs.canConfirm
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.role == .user { Spacer(minLength: 34) }

            if message.role != .user {
                Image(systemName: "sparkles")
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                    .frame(width: 27, height: 27)
                    .background(MobileFleetPalette.cyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }

            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 6) {
                    Text(message.role == .user ? (message.actor?.name ?? "You") : "Orchestra System")
                        .font(.caption2.weight(.bold))
                    if let deviceName = message.actor?.deviceName {
                        Text(deviceName)
                            .font(.caption2)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }
                    Spacer()
                    Text(message.at, style: .time)
                        .font(.caption2)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }

                FleetMarkdownText(text: message.text)

                if !message.references.isEmpty {
                    VStack(spacing: 7) {
                        ForEach(message.references) { reference in
                            referenceLink(reference)
                        }
                    }
                }

                if let pendingAction {
                    HStack(spacing: 9) {
                        Image(systemName: "bolt.shield")
                            .foregroundStyle(MobileFleetPalette.amber)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pendingAction.action.displayName)
                                .font(.caption.weight(.bold))
                            Text("\(pendingAction.deviceIds.count) device\(pendingAction.deviceIds.count == 1 ? "" : "s") · \(pendingAction.status)")
                                .font(.caption2)
                                .foregroundStyle(MobileFleetPalette.mutedText)
                        }
                        Spacer()
                        if pendingAction.status == "pending", canConfirm {
                            Button("Confirm once") { confirm(pendingAction) }
                                .buttonStyle(FleetPrimaryButtonStyle())
                        } else {
                            Image(systemName: pendingAction.status == "completed" ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                                .foregroundStyle(pendingAction.status == "completed" ? MobileFleetPalette.green : MobileFleetPalette.red)
                        }
                    }
                    .padding(9)
                    .background(MobileFleetPalette.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }

                if let conductorPlan {
                    FleetConductorPlanCard(plan: conductorPlan, canManage: canConfirm)
                }
            }
            .padding(11)
            .background(
                message.role == .user ? MobileFleetPalette.cyan.opacity(0.1) : MobileFleetPalette.raisedPanel,
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(message.role == .user ? MobileFleetPalette.cyan.opacity(0.32) : MobileFleetPalette.border, lineWidth: 1)
            }

            if message.role != .user { Spacer(minLength: 20) }
        }
    }

    @ViewBuilder
    private func referenceLink(_ reference: FleetSystemReference) -> some View {
        if reference.kind == .codexSession, let sessionID = reference.sessionId {
            NavigationLink {
                CodexChatView(sessionID: sessionID)
            } label: {
                referenceCard(reference, icon: "sparkles")
            }
            .buttonStyle(.plain)
        } else if let deviceID = reference.deviceId {
            NavigationLink {
                DeviceDetailView(deviceID: deviceID)
            } label: {
                referenceCard(reference, icon: reference.kind == .telemetry ? "gauge.with.dots.needle.67percent" : "server.rack")
            }
            .buttonStyle(.plain)
        } else {
            referenceCard(reference, icon: "link")
        }
    }

    private func referenceCard(_ reference: FleetSystemReference, icon: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: icon)
                .foregroundStyle(MobileFleetPalette.cyanBright)
                .frame(width: 28, height: 28)
                .background(MobileFleetPalette.cyan.opacity(0.1), in: RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 2) {
                Text(reference.label)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(reference.detail ?? reference.kind.rawValue)
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .padding(8)
        .background(MobileFleetPalette.panel, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct FleetConductorPlanCard: View {
    @Environment(FleetStore.self) private var store
    let plan: FleetConductorPlan
    let canManage: Bool
    @State private var pending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "wand.and.stars")
                    .foregroundStyle(MobileFleetPalette.purple)
                VStack(alignment: .leading, spacing: 2) {
                    Text("CONDUCTOR PLAN")
                        .font(.caption2.weight(.bold))
                        .tracking(0.7)
                        .foregroundStyle(MobileFleetPalette.purple)
                    Text(plan.title).font(.caption.weight(.bold))
                }
                Spacer()
                FleetMobileStatusPill(text: plan.status.rawValue.capitalized, tone: planTone)
            }

            VStack(spacing: 5) {
                ForEach(Array(plan.steps.enumerated()), id: \.element.id) { index, step in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(index + 1)")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(stepTone(step.status).color)
                            .frame(width: 23, height: 23)
                            .background(stepTone(step.status).color.opacity(0.12), in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.title).font(.caption.weight(.semibold))
                            Text(step.detail)
                                .font(.caption2)
                                .foregroundStyle(MobileFleetPalette.mutedText)
                            if let reason = step.selectionReason {
                                Text(reason)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(MobileFleetPalette.purple.opacity(0.85))
                            }
                            stepDestination(step)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(8)
                    .background(MobileFleetPalette.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 9))
                }
            }

            if plan.status == .proposed, canManage {
                HStack(spacing: 8) {
                    Button("Cancel") { Task { await cancel() } }
                        .buttonStyle(FleetSecondaryButtonStyle())
                        .disabled(pending)
                    Button {
                        Task { await execute() }
                    } label: {
                        Label(pending ? "Dispatching…" : "Approve & Run", systemImage: "play.fill")
                    }
                    .buttonStyle(FleetPrimaryButtonStyle())
                    .disabled(pending || plan.steps.allSatisfy { $0.status == .blocked })
                }
            }
        }
        .padding(10)
        .background(MobileFleetPalette.purple.opacity(0.07), in: RoundedRectangle(cornerRadius: 11))
        .overlay { RoundedRectangle(cornerRadius: 11).stroke(MobileFleetPalette.purple.opacity(0.32), lineWidth: 1) }
    }

    @ViewBuilder
    private func stepDestination(_ step: FleetConductorStep) -> some View {
        if let sessionID = step.sessionId {
            NavigationLink("Open Codex") { CodexChatView(sessionID: sessionID) }
                .font(.caption2.weight(.semibold))
        } else if let preview = step.previewUrl, let url = URL(string: preview) {
            Link("Open Website", destination: url)
                .font(.caption2.weight(.semibold))
        } else if let deviceID = step.deviceId {
            NavigationLink("Open device") { DeviceDetailView(deviceID: deviceID) }
                .font(.caption2.weight(.semibold))
        }
    }

    private var planTone: FleetMobileTone {
        switch plan.status {
        case .completed: .green
        case .failed: .red
        case .partial: .amber
        case .running: .cyan
        case .proposed, .cancelled: .neutral
        }
    }

    private func stepTone(_ status: FleetConductorStepStatus) -> FleetMobileTone {
        switch status {
        case .completed: .green
        case .failed, .blocked: .red
        case .running: .cyan
        case .pending: .purple
        case .skipped: .neutral
        }
    }

    private func execute() async {
        pending = true
        await store.executeConductorPlan(plan.id)
        pending = false
    }

    private func cancel() async {
        pending = true
        await store.cancelConductorPlan(plan.id)
        pending = false
    }
}

private func systemConversationLabel(_ conversation: FleetSystemConversation) -> String {
    conversation.messages.first(where: { $0.role == .user })?.text
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .nonEmpty ?? conversation.title
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
