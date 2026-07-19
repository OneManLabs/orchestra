import SwiftUI

enum AttentionSegment: String, CaseIterable, Identifiable {
    case approvals
    case alerts
    case notifications

    var id: Self { self }
    var title: String { rawValue.capitalized }
}

struct AlertsApprovalsView: View {
    @Environment(FleetStore.self) private var store
    @AppStorage(FleetLocalPreferences.showInAppNoticesKey) private var showInAppNotices = true
    @State private var segment: AttentionSegment

    init(initialSegment: AttentionSegment = .approvals) {
        _segment = State(initialValue: initialSegment)
    }

    private var openAlerts: [FleetAlert] {
        store.alerts
            .filter { $0.status != .resolved }
            .sorted {
                if $0.severity == $1.severity { return $0.openedAt > $1.openedAt }
                return $0.severity.sortOrder < $1.severity.sortOrder
            }
    }

    private var notifications: [FleetNotification] {
        guard showInAppNotices else { return [] }
        return store.notifications.sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Attention inbox", selection: $segment) {
                    ForEach(AttentionSegment.allCases) { item in
                        Text(segmentTitle(item)).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(MobileFleetPalette.background)

                ScrollView {
                    LazyVStack(spacing: 14) {
                        if let error = store.lastError {
                            FleetInlineError(message: error) {
                                Task { await store.refresh() }
                            }
                        }

                        switch segment {
                        case .approvals:
                            approvalsContent
                        case .alerts:
                            alertsContent
                        case .notifications:
                            notificationsContent
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 28)
                }
                .refreshable { await store.refresh() }
            }
            .navigationTitle("Attention")
            .navigationBarTitleDisplayMode(.large)
            .fleetMobileBackground()
        }
    }

    @ViewBuilder
    private var approvalsContent: some View {
        if store.approvals.isEmpty {
            FleetMobileCard {
                FleetMobileEmptyState(
                    icon: "checkmark.shield",
                    title: "No approvals pending",
                    message: "Codex and pipeline requests that need your decision will appear here."
                )
            }
        } else {
            ForEach(store.approvals.sorted { $0.createdAt > $1.createdAt }) { approval in
                ApprovalCard(approval: approval)
            }
        }
    }

    @ViewBuilder
    private var alertsContent: some View {
        if openAlerts.isEmpty {
            FleetMobileCard {
                FleetMobileEmptyState(
                    icon: "shield.checkered",
                    title: "Orchestra is clear",
                    message: "There are no open or acknowledged alerts."
                )
            }
        } else {
            ForEach(openAlerts) { alert in
                NavigationLink {
                    AlertDetailView(alert: alert)
                } label: {
                    AlertListCard(
                        alert: alert,
                        device: store.devices.first { $0.id == alert.deviceId }
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var notificationsContent: some View {
        if !showInAppNotices {
            FleetMobileCard {
                FleetMobileEmptyState(
                    icon: "bell.slash",
                    title: "In-app notices are hidden",
                    message: "Turn on Show in-app notices in Settings to display Orchestra Core notices here."
                )
            }
        } else if notifications.isEmpty {
            FleetMobileCard {
                FleetMobileEmptyState(
                    icon: "bell",
                    title: "No notifications",
                    message: "Delivery events and fleet notices will appear here."
                )
            }
        } else {
            ForEach(notifications) { notification in
                NotificationCard(notification: notification)
            }
        }
    }

    private func segmentTitle(_ segment: AttentionSegment) -> String {
        switch segment {
        case .approvals:
            store.approvals.isEmpty ? "Approvals" : "Approvals \(store.approvals.count)"
        case .alerts:
            openAlerts.isEmpty ? "Alerts" : "Alerts \(openAlerts.count)"
        case .notifications:
            "Notices"
        }
    }
}

struct AlertDetailView: View {
    @Environment(FleetStore.self) private var store
    let alert: FleetAlert

    @State private var actionInProgress = false
    @State private var showingResolveConfirmation = false

    private var currentAlert: FleetAlert {
        store.alerts.first { $0.id == alert.id } ?? alert
    }

    private var device: FleetDevice? {
        guard let deviceID = currentAlert.deviceId else { return nil }
        return store.devices.first { $0.id == deviceID }
    }

    private var job: FleetJob? {
        guard let jobID = currentAlert.jobId else { return nil }
        return store.jobs.first { $0.id == jobID }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                alertHero
                detailsCard
                relatedCard

                if currentAlert.status != .resolved {
                    actionCard
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 30)
        }
        .navigationTitle("Alert")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Resolve this alert?",
            isPresented: $showingResolveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Resolve Alert") {
                Task {
                    actionInProgress = true
                    await store.resolveAlert(currentAlert.id)
                    actionInProgress = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Resolve only after the underlying condition has been addressed.")
        }
        .fleetMobileBackground()
    }

    private var alertHero: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 15) {
                HStack(alignment: .top, spacing: 13) {
                    Image(systemName: currentAlert.severity == .critical ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                        .font(.title2)
                        .foregroundStyle(currentAlert.severity.tone.color)
                        .frame(width: 48, height: 48)
                        .background(
                            currentAlert.severity.tone.color.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 5) {
                        Text(currentAlert.title)
                            .font(.headline.weight(.bold))
                        Text(currentAlert.severity.displayName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(currentAlert.severity.tone.color)
                    }

                    Spacer()
                    FleetMobileStatusPill(
                        text: currentAlert.status.rawValue.capitalized,
                        tone: currentAlert.status == .resolved ? .green : currentAlert.severity.tone
                    )
                }

                Text(currentAlert.detail)
                    .font(.body)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var detailsCard: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 13) {
                FleetMobileSectionHeader(title: "Timeline")
                AttentionDefinitionRow(label: "Opened", value: currentAlert.openedAt.formatted(date: .abbreviated, time: .standard))
                if let acknowledgedAt = currentAlert.acknowledgedAt {
                    AttentionDefinitionRow(label: "Acknowledged", value: acknowledgedAt.formatted(date: .abbreviated, time: .standard))
                }
                if let acknowledgedBy = currentAlert.acknowledgedBy {
                    AttentionDefinitionRow(label: "Acknowledged by", value: acknowledgedBy)
                }
                if let resolvedAt = currentAlert.resolvedAt {
                    AttentionDefinitionRow(label: "Resolved", value: resolvedAt.formatted(date: .abbreviated, time: .standard))
                }
                AttentionDefinitionRow(label: "Fingerprint", value: currentAlert.fingerprint, monospaced: true)
            }
        }
    }

    @ViewBuilder
    private var relatedCard: some View {
        if device != nil || job != nil {
            FleetMobileCard {
                VStack(alignment: .leading, spacing: 10) {
                    FleetMobileSectionHeader(title: "Related")
                    if let device {
                        NavigationLink {
                            DeviceDetailView(deviceID: device.id)
                        } label: {
                            AttentionRelatedRow(
                                icon: device.role.symbolName,
                                title: device.name,
                                detail: "\(device.role.displayName) · \(device.status.displayName)"
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    if device != nil && job != nil {
                        Divider().overlay(MobileFleetPalette.softBorder)
                    }
                    if let job {
                        NavigationLink {
                            JobDetailView(jobID: job.id)
                        } label: {
                            AttentionRelatedRow(
                                icon: job.kind == .codex ? "sparkles" : "terminal",
                                title: job.name,
                                detail: job.status.displayName
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var actionCard: some View {
        FleetMobileCard {
            VStack(spacing: 10) {
                if currentAlert.status == .open {
                    Button {
                        Task {
                            actionInProgress = true
                            await store.acknowledgeAlert(currentAlert.id)
                            actionInProgress = false
                        }
                    } label: {
                        Label(actionInProgress ? "Acknowledging…" : "Acknowledge", systemImage: "hand.raised.fill")
                    }
                    .buttonStyle(FleetPrimaryButtonStyle())
                    .disabled(actionInProgress)
                }

                Button {
                    showingResolveConfirmation = true
                } label: {
                    Label("Resolve Alert", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(FleetSecondaryButtonStyle())
                .disabled(actionInProgress)
            }
        }
    }
}

private struct ApprovalCard: View {
    @Environment(FleetStore.self) private var store
    @AppStorage(FleetLocalPreferences.sensitivePreviewsKey) private var sensitivePreviews = false
    let approval: FleetMenuApproval

    @State private var responding = false
    @State private var showingDetail = false
    @State private var decision: ApprovalDecision?

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: approval.isCodex ? "sparkles" : "point.3.filled.connected.trianglepath.dotted")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(approval.isCodex ? MobileFleetPalette.purple : MobileFleetPalette.cyan)
                        .frame(width: 44, height: 44)
                        .background(
                            (approval.isCodex ? MobileFleetPalette.purple : MobileFleetPalette.cyan).opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 4) {
                        Text(approval.title)
                            .font(.headline.weight(.semibold))
                        Text(approval.contextLine)
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }

                    Spacer(minLength: 4)
                    FleetMobileStatusPill(text: "Pending", tone: .amber)
                }

                Text(
                    sensitivePreviews
                        ? approval.detail
                        : "Sensitive command and project details are hidden by your iPhone settings."
                )
                    .font(.subheadline)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .lineLimit(showingDetail ? nil : 4)
                    .fixedSize(horizontal: false, vertical: true)

                if sensitivePreviews, approval.detail.count > 180 {
                    Button(showingDetail ? "Show less" : "Show details") {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            showingDetail.toggle()
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                    .frame(minHeight: 44)
                }

                HStack(spacing: 9) {
                    Button {
                        decision = .decline
                    } label: {
                        Text("Decline")
                    }
                    .buttonStyle(FleetSecondaryButtonStyle())

                    Button {
                        decision = .accept
                    } label: {
                        Text(responding ? "Approving…" : "Approve Once")
                    }
                    .buttonStyle(FleetPrimaryButtonStyle())
                    .disabled(responding)
                }

                Text("Requested \(approval.createdAt.formatted(.relative(presentation: .named)))")
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }
        }
        .confirmationDialog(
            decision == .decline ? "Decline this request?" : "Approve this request once?",
            isPresented: Binding(
                get: { decision != nil },
                set: { if !$0 { decision = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let decision {
                Button(
                    decision == .decline ? "Decline" : "Approve Once",
                    role: decision == .decline ? .destructive : nil
                ) {
                    respond(decision)
                }
            }
            Button("Cancel", role: .cancel) { decision = nil }
        } message: {
            Text(
                sensitivePreviews
                    ? approval.detail
                    : "Sensitive details are hidden. Review them in Orchestra Canvas on a trusted screen before deciding."
            )
        }
    }

    private func respond(_ decision: ApprovalDecision) {
        self.decision = nil
        responding = true
        Task {
            await store.respond(to: approval, decision: decision)
            responding = false
        }
    }
}

private struct AlertListCard: View {
    let alert: FleetAlert
    let device: FleetDevice?

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 13) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: alert.severity == .critical ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(alert.severity.tone.color)
                        .frame(width: 40, height: 40)
                        .background(
                            alert.severity.tone.color.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 4) {
                        Text(alert.title)
                            .font(.headline.weight(.semibold))
                        Text(device?.name ?? alert.severity.displayName)
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }

                    Spacer(minLength: 4)
                    FleetMobileStatusPill(
                        text: alert.status.rawValue.capitalized,
                        tone: alert.status == .acknowledged ? .neutral : alert.severity.tone
                    )
                }

                Text(alert.detail)
                    .font(.subheadline)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .lineLimit(3)

                HStack {
                    Text(alert.severity.displayName)
                        .foregroundStyle(alert.severity.tone.color)
                    Spacer()
                    Text(alert.openedAt, style: .relative)
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(MobileFleetPalette.mutedText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens alert details")
    }
}

private struct NotificationCard: View {
    @Environment(FleetStore.self) private var store
    @AppStorage(FleetLocalPreferences.sensitivePreviewsKey) private var sensitivePreviews = false
    let notification: FleetNotification

    private var tone: FleetMobileTone {
        switch notification.severity {
        case .info: .cyan
        case .success: .green
        case .warning: .amber
        case .critical: .red
        }
    }

    var body: some View {
        FleetMobileCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: notification.severity == .critical ? "bell.badge.fill" : "bell.fill")
                    .foregroundStyle(tone.color)
                    .frame(width: 38, height: 38)
                    .background(tone.color.opacity(0.1), in: RoundedRectangle(cornerRadius: 11, style: .continuous))

                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(notification.title)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(notification.createdAt, style: .relative)
                            .font(.caption2)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }
                    Text(
                        sensitivePreviews
                            ? notification.body
                            : "Sensitive notice details are hidden by your iPhone settings."
                    )
                        .font(.caption)
                        .foregroundStyle(MobileFleetPalette.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)

                    if notification.status != .read {
                        Button("Mark as read") {
                            Task { await store.markNotificationRead(notification.id) }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MobileFleetPalette.cyanBright)
                        .frame(minHeight: 44)
                    }
                }
            }
        }
        .opacity(notification.status == .read ? 0.66 : 1)
        .accessibilityElement(children: .combine)
    }
}

private struct AttentionDefinitionRow: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(MobileFleetPalette.mutedText)
            Spacer(minLength: 10)
            Text(value)
                .font(monospaced ? .caption.monospaced() : .subheadline)
                .foregroundStyle(MobileFleetPalette.secondaryText)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct AttentionRelatedRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .foregroundStyle(MobileFleetPalette.cyan)
                .frame(width: 34, height: 34)
                .background(MobileFleetPalette.cyan.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

private extension FleetAlertSeverity {
    var sortOrder: Int {
        switch self {
        case .critical: 0
        case .warning: 1
        case .info: 2
        }
    }
}

private extension FleetMenuApproval {
    var isCodex: Bool {
        if case .codex = self { return true }
        return false
    }

    var contextLine: String {
        switch self {
        case let .codex(value):
            [value.deviceName, "Codex"].compactMap { $0 }.joined(separator: " · ")
        case let .pipeline(value):
            [value.pipelineName, value.deviceName, "Pipeline"].compactMap { $0 }.joined(separator: " · ")
        }
    }
}
