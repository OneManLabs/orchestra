import SwiftUI

struct MissionDashboardView: View {
    @Environment(FleetStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var showingNewJob = false

    private var onlineDevices: [FleetDevice] {
        store.reachableDevices
    }

    private var activeJobs: [FleetJob] {
        store.activeJobs
    }

    private var openAlerts: [FleetAlert] {
        store.alerts.filter { $0.status == .open }
    }

    private var isNominal: Bool {
        if let health = store.menuSnapshot?.summary.status {
            return fleetMenuHealthIsNominal(health)
        }
        return !store.devices.isEmpty &&
            !store.devices.contains { $0.status == .degraded } &&
            !openAlerts.contains { $0.severity == .critical }
    }

    private var healthLabel: String {
        guard !store.devices.isEmpty else { return "Awaiting fleet data" }
        switch store.menuSnapshot?.summary.status {
        case .healthy:
            return "Orchestra nominal"
        case .critical:
            return "Critical attention"
        case .degraded:
            return "Attention required"
        case nil:
            return isNominal ? "Orchestra nominal" : "Attention required"
        }
    }

    private var healthColor: Color {
        switch store.menuSnapshot?.summary.status {
        case .healthy:
            MobileFleetPalette.green
        case .critical:
            MobileFleetPalette.red
        case .degraded:
            MobileFleetPalette.amber
        case nil:
            isNominal ? MobileFleetPalette.green : MobileFleetPalette.amber
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 18) {
                    missionHeader

                    if let error = store.lastError {
                        FleetInlineError(message: error) {
                            Task { await store.refresh() }
                        }
                    }

                    capacityStrip
                    attentionSection
                    sharedWorkspacesSection
                    codexSessionsSection
                    activeWorkSection
                    devicesSection
                    activitySection
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 28)
            }
            .refreshable { await store.refresh() }
            .navigationTitle("Mission")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingNewJob = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Create a job")
                }
            }
            .sheet(isPresented: $showingNewJob) {
                NewJobView()
            }
            .fleetMobileBackground()
        }
    }

    private var missionCodexSessions: [CodexSession] {
        let current = store.currentCodexSessions
        let currentIDs = Set(current.map(\.id))
        let recent = store.recentCodexSessions.filter { !currentIDs.contains($0.id) }
        return Array((current + recent).prefix(4))
    }

    @ViewBuilder
    private var codexSessionsSection: some View {
        if !store.sessions.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                FleetMobileSectionHeader(
                    title: "Codex sessions",
                    detail: store.currentCodexSessions.isEmpty
                        ? "Recent conversations across the fleet"
                        : "\(store.currentCodexSessions.count) current across the fleet"
                )

                ForEach(missionCodexSessions) { session in
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

                NavigationLink {
                    CodexSessionsView()
                } label: {
                    Label("View all Codex sessions", systemImage: "arrow.right.circle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(MobileFleetPalette.cyanBright)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                        .background(
                            MobileFleetPalette.panel,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(MobileFleetPalette.border, lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var sharedWorkspacesSection: some View {
        if !store.projects.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                FleetMobileSectionHeader(
                    title: "Shared workspaces",
                    detail: "Open the website and Codex session from this iPhone"
                )

                ForEach(store.projects) { project in
                    MissionSharedWorkspaceCard(
                        project: project,
                        host: store.devices.first { $0.id == project.preview?.deviceId },
                        session: store.sessions
                            .filter { $0.projectId == project.id }
                            .sorted { $0.updatedAt > $1.updatedAt }
                            .first,
                        startPreview: {
                            Task { await store.startProjectPreview(project.id) }
                        },
                        stopPreview: {
                            Task { await store.stopProjectPreview(project.id) }
                        },
                        openPreview: {
                            guard let value = project.preview?.url, let url = URL(string: value) else { return }
                            Task { await store.touchProjectPreview(project.id) }
                            openURL(url)
                        },
                        openPreviewSetup: {
                            guard let url = project.preview?.error?.tailscaleSetupURL else { return }
                            openURL(url)
                        }
                    )
                }
            }
        }
    }

    private var missionHeader: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 17) {
                HStack(alignment: .top, spacing: 14) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [MobileFleetPalette.cyanBright, MobileFleetPalette.cyan],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                        Image(systemName: "command")
                            .font(.system(size: 23, weight: .bold))
                            .foregroundStyle(MobileFleetPalette.background)
                    }
                    .frame(width: 52, height: 52)
                    .shadow(color: MobileFleetPalette.cyan.opacity(0.22), radius: 18, y: 7)
                    .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 5) {
                        Text(store.snapshot?.settings.fleetName ?? "Orchestra")
                            .font(.title3.weight(.bold))
                        Text(healthLabel)
                            .font(.subheadline)
                            .foregroundStyle(healthColor)
                    }

                    Spacer()

                    Circle()
                        .fill(store.connectionState.isConnected ? MobileFleetPalette.green : MobileFleetPalette.red)
                        .frame(width: 9, height: 9)
                        .shadow(
                            color: (store.connectionState.isConnected ? MobileFleetPalette.green : MobileFleetPalette.red).opacity(0.7),
                            radius: 7
                        )
                        .padding(.top, 7)
                        .accessibilityLabel(store.connectionState.isConnected ? "Core connected" : "Core disconnected")
                }

                HStack(spacing: 0) {
                    MissionHeaderStat(value: "\(onlineDevices.count)", label: "Online")
                    Divider().overlay(MobileFleetPalette.border)
                    MissionHeaderStat(value: "\(activeJobs.count)", label: "Jobs")
                    Divider().overlay(MobileFleetPalette.border)
                    MissionHeaderStat(value: "\(store.activeCodexSessions.count)", label: "Codex")
                    Divider().overlay(MobileFleetPalette.border)
                    MissionHeaderStat(value: "\(store.approvals.count + openAlerts.count)", label: "Attention")
                }
                .frame(height: 42)
            }
        }
    }

    private var capacityStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 11) {
                MissionMetricCard(
                    icon: "cpu",
                    title: "CPU fabric",
                    value: "\(store.devices.reduce(0) { $0 + $1.metrics.cpu.cores }) cores",
                    detail: "Across \(store.devices.count) devices",
                    tone: .cyan
                )
                MissionMetricCard(
                    icon: "memorychip",
                    title: "Memory",
                    value: FleetMobileFormatter.bytes(store.devices.reduce(0) { $0 + $1.metrics.memory.totalBytes }),
                    detail: "Visible capacity",
                    tone: .purple
                )
                MissionMetricCard(
                    icon: "bolt.fill",
                    title: "Power",
                    value: currentPower.map { "\(Int($0.rounded())) W" } ?? "—",
                    detail: currentPower == nil ? "Telemetry unavailable" : "Current estimate",
                    tone: .amber
                )
                MissionMetricCard(
                    icon: "shield.checkered",
                    title: "Security",
                    value: openAlerts.contains { $0.severity == .critical } ? "Critical" : "Clear",
                    detail: "\(openAlerts.count) open alerts",
                    tone: openAlerts.contains { $0.severity == .critical } ? .red : .green
                )
            }
        }
        .contentMargins(.horizontal, 1, for: .scrollContent)
        .accessibilityLabel("Orchestra capacity summary")
    }

    @ViewBuilder
    private var attentionSection: some View {
        if !store.approvals.isEmpty || !openAlerts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                FleetMobileSectionHeader(
                    title: "Needs attention",
                    detail: "\(store.approvals.count + openAlerts.count) items require review"
                )

                FleetMobileCard {
                    VStack(spacing: 0) {
                        ForEach(store.approvals.prefix(3)) { approval in
                            NavigationLink {
                                AlertsApprovalsView(initialSegment: .approvals)
                            } label: {
                                MissionAttentionRow(
                                    icon: "checkmark.shield.fill",
                                    title: approval.title,
                                    detail: approval.detail,
                                    tone: .amber
                                )
                            }
                            .buttonStyle(.plain)

                            if approval.id != store.approvals.prefix(3).last?.id {
                                Divider().overlay(MobileFleetPalette.softBorder)
                            }
                        }

                        if !store.approvals.isEmpty && !openAlerts.isEmpty {
                            Divider().overlay(MobileFleetPalette.softBorder)
                        }

                        ForEach(openAlerts.prefix(max(0, 3 - store.approvals.count))) { alert in
                            NavigationLink {
                                AlertDetailView(alert: alert)
                            } label: {
                                MissionAttentionRow(
                                    icon: alert.severity == .critical ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill",
                                    title: alert.title,
                                    detail: alert.detail,
                                    tone: alert.severity.tone
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var activeWorkSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            FleetMobileSectionHeader(
                title: "Active work",
                detail: activeJobs.isEmpty ? "No jobs are currently executing" : "\(activeJobs.count) jobs in motion"
            )

            if activeJobs.isEmpty {
                FleetMobileCard {
                    FleetMobileEmptyState(
                        icon: "bolt.horizontal.circle",
                        title: "Orchestra is idle",
                        message: "Dispatch a Codex or shell job when you are ready.",
                        actionTitle: "New job"
                    ) {
                        showingNewJob = true
                    }
                }
            } else {
                ForEach(activeJobs) { job in
                    NavigationLink {
                        JobDetailView(jobID: job.id)
                    } label: {
                        MissionJobCard(job: job, device: store.devices.first { $0.id == job.deviceId })
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            FleetMobileSectionHeader(
                title: "Orchestra",
                detail: "\(onlineDevices.count) of \(store.devices.count) devices reachable"
            )

            if store.devices.isEmpty {
                FleetMobileCard {
                    FleetMobileEmptyState(
                        icon: "server.rack",
                        title: "No devices visible",
                        message: "Connect to Orchestra Core or enroll an Agent to populate your fleet."
                    )
                }
            } else {
                FleetMobileCard {
                    VStack(spacing: 0) {
                        ForEach(Array(store.orderedDevices.enumerated()), id: \.element.id) { index, device in
                            NavigationLink {
                                DeviceDetailView(deviceID: device.id)
                            } label: {
                                MissionDeviceRow(device: device)
                            }
                            .buttonStyle(.plain)

                            if index < store.orderedDevices.count - 1 {
                                Divider().overlay(MobileFleetPalette.softBorder)
                            }
                        }
                    }
                }
            }
        }
    }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            FleetMobileSectionHeader(
                title: "Recent operations",
                detail: "Live activity across the fleet"
            )

            FleetMobileCard {
                if store.activity.isEmpty {
                    FleetMobileEmptyState(
                        icon: "clock.arrow.circlepath",
                        title: "No recent operations",
                        message: "Device, job, and security events will appear here."
                    )
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(store.activity.prefix(6).enumerated()), id: \.element.id) { index, event in
                            MissionActivityRow(event: event)
                            if index < min(store.activity.count, 6) - 1 {
                                Divider().overlay(MobileFleetPalette.softBorder)
                            }
                        }
                    }
                }
            }
        }
    }

    private var currentPower: Double? {
        let values = store.devices.compactMap(\.metrics.powerDrawWatts)
        return values.isEmpty ? nil : values.reduce(0, +)
    }
}

private struct MissionSharedWorkspaceCard: View {
    let project: FleetProject
    let host: FleetDevice?
    let session: CodexSession?
    let startPreview: () -> Void
    let stopPreview: () -> Void
    let openPreview: () -> Void
    let openPreviewSetup: () -> Void

    private var preview: ProjectPreview? { project.preview }

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: "macwindow.on.rectangle")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(MobileFleetPalette.cyanBright)
                        .frame(width: 42, height: 42)
                        .background(
                            MobileFleetPalette.cyan.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 3) {
                        Text(project.name)
                            .font(.headline.weight(.semibold))
                        Text(host.map { "Hosted on \($0.name)" } ?? "Choose an online project device")
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }

                    Spacer()
                    if let preview {
                        FleetMobileStatusPill(
                            text: preview.status.displayName,
                            tone: preview.status.tone
                        )
                    }
                }

                HStack(spacing: 10) {
                    Label(
                        preview?.status == .running ? "Preview available" : "Preview not running",
                        systemImage: "globe"
                    )
                    Spacer()
                    if let preview, preview.port > 0 {
                        Text("\(preview.framework) · :\(preview.port)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)

                if let preview {
                    HStack(spacing: 10) {
                        Label(
                            preview.desiredState == .stopped ? "Stopped by operator" : "Persistent · auto-recovers",
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                        Spacer()
                        if let health = preview.health {
                            Text(health.state.rawValue.capitalized + (health.latencyMs.map { " · \(Int($0.rounded())) ms" } ?? ""))
                                .foregroundStyle(health.state.tone.color)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                }

                HStack(spacing: 9) {
                    if preview?.status == .running, preview?.url != nil {
                        Button(action: openPreview) {
                            Label("Open Website", systemImage: "arrow.up.right.square")
                        }
                        .buttonStyle(FleetPrimaryButtonStyle())

                        Button(action: stopPreview) {
                            Image(systemName: "stop.fill")
                                .frame(width: 42, height: 42)
                        }
                        .buttonStyle(FleetSecondaryButtonStyle())
                        .accessibilityLabel("Stop shared preview")
                    } else {
                        Button(action: startPreview) {
                            Label(
                                preview?.status == .offline || preview?.status == .error
                                    ? "Restart Preview"
                                    : "Start Shared Preview",
                                systemImage: "play.fill"
                            )
                        }
                        .buttonStyle(FleetPrimaryButtonStyle())
                    }

                    if let session {
                        NavigationLink {
                            CodexChatView(sessionID: session.id)
                        } label: {
                            Label("Open Codex", systemImage: "sparkles")
                        }
                        .buttonStyle(FleetSecondaryButtonStyle())
                    }
                }

                if let error = preview?.error, !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(MobileFleetPalette.red)
                }

                if preview?.error?.tailscaleSetupURL != nil {
                    Button(action: openPreviewSetup) {
                        Label(
                            "Enable Tailscale \(preview?.visibility == .public ? "Funnel" : "Serve")",
                            systemImage: "shield.checkered"
                        )
                    }
                    .buttonStyle(FleetSecondaryButtonStyle())
                }
            }
        }
    }
}

private extension String {
    var tailscaleSetupURL: URL? {
        components(separatedBy: .whitespacesAndNewlines)
            .compactMap { URL(string: $0.trimmingCharacters(in: .punctuationCharacters)) }
            .first { $0.host == "login.tailscale.com" }
    }
}

private extension ProjectPreviewStatus {
    var displayName: String {
        rawValue.capitalized
    }

    var tone: FleetMobileTone {
        switch self {
        case .running: .green
        case .starting, .restarting: .cyan
        case .offline, .error: .red
        case .stopped: .neutral
        }
    }
}

private extension ProjectPreviewHealthState {
    var tone: FleetMobileTone {
        switch self {
        case .healthy: .green
        case .starting, .degraded: .amber
        case .unreachable: .red
        case .unknown: .neutral
        }
    }
}

private struct MissionHeaderStat: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.headline.weight(.bold))
                .monospacedDigit()
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private struct MissionMetricCard: View {
    let icon: String
    let title: String
    let value: String
    let detail: String
    let tone: FleetMobileTone

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(tone.color)
                .frame(width: 34, height: 34)
                .background(tone.color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(MobileFleetPalette.secondaryText)
            Text(value)
                .font(.title3.weight(.bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
                .lineLimit(1)
        }
        .padding(14)
        .frame(width: 154, height: 150, alignment: .leading)
        .background(MobileFleetPalette.panel, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .stroke(MobileFleetPalette.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct MissionAttentionRow: View {
    let icon: String
    let title: String
    let detail: String
    let tone: FleetMobileTone

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(tone.color)
                .frame(width: 36, height: 36)
                .background(tone.color.opacity(0.1), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}

private struct MissionJobCard: View {
    let job: FleetJob
    let device: FleetDevice?

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 11) {
                    Image(systemName: job.kind == .codex ? "sparkles" : "terminal")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan)
                        .frame(width: 38, height: 38)
                        .background(
                            (job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan).opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 3) {
                        Text(job.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Text([device?.name, job.phase].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                            .lineLimit(1)
                    }

                    Spacer()
                    FleetMobileStatusPill(text: job.status.displayName, tone: job.status.tone)
                }

                if let progress = job.progress {
                    FleetMobileMetricBar(label: job.phase ?? "Progress", value: progress)
                }
            }
        }
    }
}

private struct MissionDeviceRow: View {
    let device: FleetDevice

    var body: some View {
        HStack(spacing: 12) {
            FleetDeviceGlyph(role: device.role, size: 39)
            VStack(alignment: .leading, spacing: 3) {
                Text(device.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("\(device.role.displayName) · \(Int(device.metrics.cpu.usagePercent.rounded()))% CPU")
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }
            Spacer(minLength: 4)
            FleetMobileStatusPill(text: device.status.displayName, tone: device.status.tone)
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct MissionActivityRow: View {
    let event: FleetActivityEvent

    private var tone: FleetMobileTone {
        switch event.severity {
        case .info: .cyan
        case .success: .green
        case .warning: .amber
        case .error: .red
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(tone.color)
                .frame(width: 8, height: 8)
                .shadow(color: tone.color.opacity(0.5), radius: 4)
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 3) {
                Text(event.title)
                    .font(.subheadline.weight(.semibold))
                Text(event.detail)
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .lineLimit(2)
            }

            Spacer(minLength: 4)
            Text(event.at, style: .relative)
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
                .monospacedDigit()
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}
