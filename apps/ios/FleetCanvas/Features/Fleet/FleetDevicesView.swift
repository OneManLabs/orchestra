import SwiftUI

struct FleetDevicesView: View {
    @Environment(FleetStore.self) private var store
    @State private var query = ""
    @State private var statusFilter: FleetDeviceStatus?

    private var filteredDevices: [FleetDevice] {
        store.orderedDevices
            .filter { statusFilter == nil || $0.status == statusFilter }
            .filter {
                query.isEmpty ||
                    $0.name.localizedCaseInsensitiveContains(query) ||
                    $0.hostname.localizedCaseInsensitiveContains(query) ||
                    $0.role.displayName.localizedCaseInsensitiveContains(query)
            }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 14) {
                    if let error = store.lastError {
                        FleetInlineError(message: error) {
                            Task { await store.refresh() }
                        }
                    }

                    fleetSummary
                    filters

                    if filteredDevices.isEmpty {
                        FleetMobileCard {
                            FleetMobileEmptyState(
                                icon: store.devices.isEmpty ? "server.rack" : "magnifyingglass",
                                title: store.devices.isEmpty ? "No devices enrolled" : "No matching devices",
                                message: store.devices.isEmpty
                                    ? "Your enrolled Tailscale devices will appear after their Orchestra Agents connect."
                                    : "Try changing the search or status filter."
                            )
                        }
                    } else {
                        ForEach(filteredDevices) { device in
                            NavigationLink {
                                DeviceDetailView(deviceID: device.id)
                            } label: {
                                DeviceListCard(device: device)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 28)
            }
            .refreshable { await store.refresh() }
            .navigationTitle("Devices")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Devices, hosts, or roles")
            .fleetMobileBackground()
        }
    }

    private var fleetSummary: some View {
        FleetMobileCard {
            HStack(spacing: 0) {
                DeviceSummaryStat(
                    value: "\(store.devices.filter { $0.presence?.summary == .operational || $0.presence?.summary == .degraded || $0.status != .offline && $0.presence == nil }.count)",
                    label: "Reachable",
                    color: MobileFleetPalette.green
                )
                Divider().overlay(MobileFleetPalette.border)
                DeviceSummaryStat(
                    value: "\(store.devices.filter { $0.status == .busy }.count)",
                    label: "Busy",
                    color: MobileFleetPalette.cyan
                )
                Divider().overlay(MobileFleetPalette.border)
                DeviceSummaryStat(
                    value: "\(store.devices.filter { $0.status == .degraded }.count)",
                    label: "Degraded",
                    color: MobileFleetPalette.amber
                )
                Divider().overlay(MobileFleetPalette.border)
                DeviceSummaryStat(
                    value: "\(store.devices.filter { $0.status == .offline }.count)",
                    label: "Offline",
                    color: MobileFleetPalette.mutedText
                )
            }
            .frame(height: 48)
        }
    }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                DeviceFilterChip(title: "All", selected: statusFilter == nil) {
                    statusFilter = nil
                }
                ForEach(FleetDeviceStatus.allCases, id: \.self) { status in
                    DeviceFilterChip(
                        title: status.displayName,
                        selected: statusFilter == status,
                        tone: status.tone
                    ) {
                        statusFilter = status
                    }
                }
            }
        }
        .contentMargins(.horizontal, 1, for: .scrollContent)
        .accessibilityLabel("Filter devices by status")
    }
}

struct DeviceDetailView: View {
    @Environment(FleetStore.self) private var store
    let deviceID: String

    @State private var pendingPowerAction: FleetPowerAction?
    @State private var showingNewSession = false
    @State private var showingPowerMenu = false
    @State private var actionInProgress = false
    @State private var sessionNavigation = CodexSessionNavigationState()

    private var device: FleetDevice? {
        store.devices.first { $0.id == deviceID }
    }

    private var deviceJobs: [FleetJob] {
        store.jobs.filter { $0.deviceId == deviceID }
    }

    private var deviceSessions: [CodexSession] {
        let currentIDs = Set(store.currentCodexSessions.map(\.id))
        return store.sessions
            .filter { $0.deviceId == deviceID }
            .sorted { left, right in
                let leftCurrent = currentIDs.contains(left.id)
                let rightCurrent = currentIDs.contains(right.id)
                if leftCurrent != rightCurrent { return leftCurrent }
                return left.updatedAt > right.updatedAt
            }
    }

    var body: some View {
        ScrollView {
            if let device {
                LazyVStack(spacing: 16) {
                    deviceHero(device)
                    presenceCard(device)
                    quickActions(device)
                    codexSessionsCard
                    resourceCard(device)

                    if !device.metrics.gpus.isEmpty {
                        gpuCard(device)
                    }

                    networkCard(device)
                    capabilityCard(device)
                    recentJobsCard
                    identityCard(device)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 30)
            } else {
                FleetMobileEmptyState(
                    icon: "questionmark.folder",
                    title: "Device unavailable",
                    message: "This device is no longer present in the current Orchestra snapshot."
                )
                .padding(16)
            }
        }
        .refreshable { await store.refresh() }
        .navigationTitle(device?.name ?? "Device")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingPowerMenu = true
                } label: {
                    Image(systemName: "power")
                        .frame(width: 44, height: 44)
                }
                .disabled(device == nil || actionInProgress)
                .accessibilityLabel("Power controls")
            }
        }
        .confirmationDialog(
            "Power controls",
            isPresented: $showingPowerMenu,
            titleVisibility: .visible
        ) {
            if device?.capabilities.wakeOnLan == true || device?.status == .offline {
                Button("Wake") { pendingPowerAction = .wake }
            }
            if device?.status != .offline {
                Button("Lock") { pendingPowerAction = .lock }
                Button("Sleep") { pendingPowerAction = .sleep }
                Button("Restart", role: .destructive) { pendingPowerAction = .restart }
                Button("Shut Down", role: .destructive) { pendingPowerAction = .shutdown }
            }
        } message: {
            Text("Power actions are sent through Orchestra Core and may require policy approval.")
        }
        .confirmationDialog(
            powerConfirmationTitle,
            isPresented: Binding(
                get: { pendingPowerAction != nil },
                set: { if !$0 { pendingPowerAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let action = pendingPowerAction {
                Button(powerActionLabel(action), role: action == .wake || action == .lock ? nil : .destructive) {
                    Task { await performPowerAction(action) }
                }
            }
            Button("Cancel", role: .cancel) { pendingPowerAction = nil }
        } message: {
            Text("This action affects \(device?.name ?? "the selected device") immediately.")
        }
        .sheet(isPresented: $showingNewSession, onDismiss: {
            sessionNavigation.presentPendingSession()
        }) {
            NewCodexSessionView(initialDeviceID: deviceID) { sessionID in
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

    private func deviceHero(_ device: FleetDevice) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    FleetDeviceGlyph(role: device.role, size: 56)

                    VStack(alignment: .leading, spacing: 5) {
                        Text(device.name)
                            .font(.title3.weight(.bold))
                        Text("\(device.osName) \(device.osVersion) · \(device.arch)")
                            .font(.subheadline)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                            .lineLimit(2)
                    }

                    Spacer(minLength: 4)
                    FleetMobileStatusPill(
                        text: device.presence?.label ?? device.status.displayName,
                        tone: device.presence?.summary.tone ?? device.status.tone
                    )
                }

                HStack(spacing: 12) {
                    Label(device.role.displayName, systemImage: "square.stack.3d.up")
                    Label("\(device.activeJobIds.count) jobs", systemImage: "bolt")
                    Label("\(device.activeSessionIds.count) Codex", systemImage: "sparkles")
                }
                .font(.caption)
                .foregroundStyle(MobileFleetPalette.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.78)
            }
        }
    }

    @ViewBuilder
    private func presenceCard(_ device: FleetDevice) -> some View {
        if let presence = device.presence {
            FleetMobileCard {
                VStack(alignment: .leading, spacing: 12) {
                    FleetMobileSectionHeader(title: "Truthful presence", detail: presence.detail)
                    ForEach(Array([
                        ("Agent", presence.agent),
                        ("Tailscale", presence.tailscale),
                        ("LAN", presence.lan),
                        ("Services", presence.services),
                    ].enumerated()), id: \.offset) { index, item in
                        HStack(alignment: .top, spacing: 10) {
                            Circle()
                                .fill(item.1.state.tone.color)
                                .frame(width: 7, height: 7)
                                .padding(.top, 5)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.0).font(.caption.weight(.semibold))
                                Text(item.1.detail)
                                    .font(.caption2)
                                    .foregroundStyle(MobileFleetPalette.mutedText)
                            }
                            Spacer(minLength: 4)
                            Text(item.1.checkedAt, style: .relative)
                                .font(.caption2)
                                .foregroundStyle(MobileFleetPalette.mutedText)
                        }
                        if index < 3 { Divider().overlay(MobileFleetPalette.softBorder) }
                    }
                }
            }
        }
    }

    private func quickActions(_ device: FleetDevice) -> some View {
        HStack(spacing: 10) {
            Button {
                showingNewSession = true
            } label: {
                Label("New Codex", systemImage: "sparkles")
            }
            .buttonStyle(FleetPrimaryButtonStyle())
            .disabled(!device.capabilities.codex || device.status == .offline)

            Button {
                pendingPowerAction = device.status == .offline ? .wake : .restart
            } label: {
                Image(systemName: device.status == .offline ? "sun.max.fill" : "arrow.clockwise")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(FleetSecondaryButtonStyle())
            .accessibilityLabel(device.status == .offline ? "Wake device" : "Restart device")
        }
    }

    @ViewBuilder
    private var codexSessionsCard: some View {
        if !deviceSessions.isEmpty {
            FleetMobileCard {
                VStack(alignment: .leading, spacing: 12) {
                    FleetMobileSectionHeader(
                        title: "Codex sessions",
                        detail: "\(deviceSessions.count) conversation\(deviceSessions.count == 1 ? "" : "s") on this device"
                    )

                    ForEach(Array(deviceSessions.prefix(5).enumerated()), id: \.element.id) { index, session in
                        NavigationLink {
                            CodexChatView(sessionID: session.id)
                        } label: {
                            HStack(spacing: 11) {
                                FleetStatusDot(
                                    tone: session.status.fleetTone,
                                    animated: session.status == .thinking || session.status == .starting
                                )
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(session.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(MobileFleetPalette.primaryText)
                                        .lineLimit(1)
                                    Text(session.events.last(where: { $0.type == .assistant || $0.type == .user })?.text ?? session.cwd)
                                        .font(.caption)
                                        .foregroundStyle(MobileFleetPalette.mutedText)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 4)
                                FleetMobileStatusPill(
                                    text: session.status.displayName,
                                    tone: session.status.tone
                                )
                            }
                            .frame(minHeight: 54)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if index < min(deviceSessions.count, 5) - 1 {
                            Divider().overlay(MobileFleetPalette.softBorder)
                        }
                    }
                }
            }
        }
    }

    private func resourceCard(_ device: FleetDevice) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 16) {
                FleetMobileSectionHeader(
                    title: "Resources",
                    detail: "Sampled \(device.metrics.sampledAt.formatted(.relative(presentation: .numeric)))"
                )
                FleetMobileMetricBar(
                    label: "CPU",
                    value: device.metrics.cpu.usagePercent,
                    valueLabel: "\(Int(device.metrics.cpu.usagePercent.rounded()))% · \(device.metrics.cpu.cores) cores"
                )
                FleetMobileMetricBar(
                    label: "Memory",
                    value: device.metrics.memory.usagePercent,
                    valueLabel: "\(FleetMobileFormatter.bytes(device.metrics.memory.usedBytes)) / \(FleetMobileFormatter.bytes(device.metrics.memory.totalBytes))",
                    tint: MobileFleetPalette.purple
                )
                if let storage = device.metrics.storage.max(by: { $0.usagePercent < $1.usagePercent }) {
                    FleetMobileMetricBar(
                        label: "Storage · \(storage.mount)",
                        value: storage.usagePercent,
                        valueLabel: "\(Int(storage.usagePercent.rounded()))%",
                        tint: storage.usagePercent >= 90 ? MobileFleetPalette.red : MobileFleetPalette.green
                    )
                }

                HStack {
                    DeviceMiniMetric(icon: "clock", value: FleetMobileFormatter.duration(device.metrics.uptimeSeconds), label: "Uptime")
                    DeviceMiniMetric(
                        icon: "thermometer.medium",
                        value: device.metrics.cpu.temperatureCelsius.map { "\(Int($0.rounded()))°C" } ?? "—",
                        label: "CPU temp"
                    )
                    DeviceMiniMetric(
                        icon: "bolt.fill",
                        value: device.metrics.powerDrawWatts.map { "\(Int($0.rounded())) W" } ?? "—",
                        label: "Power"
                    )
                }
            }
        }
    }

    private func gpuCard(_ device: FleetDevice) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 16) {
                FleetMobileSectionHeader(title: "Accelerators", detail: "\(device.metrics.gpus.count) detected")

                ForEach(Array(device.metrics.gpus.enumerated()), id: \.offset) { index, gpu in
                    VStack(alignment: .leading, spacing: 11) {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(gpu.model)
                                    .font(.subheadline.weight(.semibold))
                                Text(gpu.vendor)
                                    .font(.caption)
                                    .foregroundStyle(MobileFleetPalette.mutedText)
                            }
                            Spacer()
                            if let temperature = gpu.temperatureCelsius {
                                Text("\(Int(temperature.rounded()))°C")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(temperature >= 85 ? MobileFleetPalette.red : MobileFleetPalette.secondaryText)
                                    .monospacedDigit()
                            }
                        }

                        if let usage = gpu.usagePercent {
                            FleetMobileMetricBar(label: "GPU", value: usage, tint: MobileFleetPalette.purple)
                        }
                        if let used = gpu.vramUsedBytes, let total = gpu.vramTotalBytes, total > 0 {
                            FleetMobileMetricBar(
                                label: "VRAM",
                                value: used / total * 100,
                                valueLabel: "\(FleetMobileFormatter.bytes(used)) / \(FleetMobileFormatter.bytes(total))",
                                tint: MobileFleetPalette.purple
                            )
                        }
                    }

                    if index < device.metrics.gpus.count - 1 {
                        Divider().overlay(MobileFleetPalette.softBorder)
                    }
                }
            }
        }
    }

    private func networkCard(_ device: FleetDevice) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 14) {
                FleetMobileSectionHeader(title: "Network", detail: device.capabilities.tailscale ? "Tailscale connected" : "Tailscale unavailable")

                DeviceDefinitionRow(label: "Tailscale DNS", value: device.metrics.network.tailscaleDnsName ?? "—")
                DeviceDefinitionRow(label: "Tailscale IP", value: device.metrics.network.tailscaleIp ?? "—", monospaced: true)
                DeviceDefinitionRow(label: "Download", value: "\(FleetMobileFormatter.bytes(device.metrics.network.rxBytesPerSecond))/s")
                DeviceDefinitionRow(label: "Upload", value: "\(FleetMobileFormatter.bytes(device.metrics.network.txBytesPerSecond))/s")
            }
        }
    }

    private func capabilityCard(_ device: FleetDevice) -> some View {
        let capabilities: [(String, String, Bool)] = [
            ("sparkles", "Codex", device.capabilities.codex),
            ("point.3.connected.trianglepath.dotted", "CUDA", device.capabilities.cuda),
            ("apple.logo", "MLX", device.capabilities.mlx),
            ("shippingbox", "Docker", device.capabilities.docker),
            ("chevron.left.forwardslash.chevron.right", "Git", device.capabilities.git),
            ("network", "Tailscale", device.capabilities.tailscale),
            ("sun.max", "Wake-on-LAN", device.capabilities.wakeOnLan)
        ]

        return FleetMobileCard {
            VStack(alignment: .leading, spacing: 14) {
                FleetMobileSectionHeader(title: "Capabilities")

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 9) {
                    ForEach(capabilities, id: \.1) { icon, label, available in
                        Label(label, systemImage: available ? icon : "minus.circle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(available ? MobileFleetPalette.secondaryText : MobileFleetPalette.mutedText.opacity(0.6))
                            .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                            .padding(.horizontal, 10)
                            .background(MobileFleetPalette.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .accessibilityLabel("\(label), \(available ? "available" : "unavailable")")
                    }
                }

                if !device.capabilities.labels.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(device.capabilities.labels, id: \.self) { label in
                            Text(label)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(MobileFleetPalette.secondaryText)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(MobileFleetPalette.border.opacity(0.7), in: Capsule())
                        }
                    }
                }
            }
        }
    }

    private var recentJobsCard: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 10) {
                FleetMobileSectionHeader(title: "Recent jobs", detail: "\(deviceJobs.count) assigned")

                if deviceJobs.isEmpty {
                    FleetMobileEmptyState(
                        icon: "shippingbox",
                        title: "No device jobs",
                        message: "Jobs assigned to this device will appear here."
                    )
                } else {
                    ForEach(Array(deviceJobs.prefix(4).enumerated()), id: \.element.id) { index, job in
                        NavigationLink {
                            JobDetailView(jobID: job.id)
                        } label: {
                            HStack(spacing: 11) {
                                Image(systemName: job.kind == .codex ? "sparkles" : "terminal")
                                    .foregroundStyle(job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan)
                                    .frame(width: 30)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(job.name)
                                        .font(.subheadline.weight(.semibold))
                                        .lineLimit(1)
                                    Text(job.createdAt, style: .relative)
                                        .font(.caption)
                                        .foregroundStyle(MobileFleetPalette.mutedText)
                                }
                                Spacer()
                                FleetMobileStatusPill(text: job.status.displayName, tone: job.status.tone)
                            }
                            .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)

                        if index < min(deviceJobs.count, 4) - 1 {
                            Divider().overlay(MobileFleetPalette.softBorder)
                        }
                    }
                }
            }
        }
    }

    private func identityCard(_ device: FleetDevice) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 13) {
                FleetMobileSectionHeader(title: "Agent identity")
                DeviceDefinitionRow(label: "Hostname", value: device.hostname, monospaced: true)
                DeviceDefinitionRow(label: "Agent", value: "v\(device.agentVersion)")
                DeviceDefinitionRow(label: "Platform", value: device.platform)
                DeviceDefinitionRow(label: "Shell", value: device.capabilities.shell, monospaced: true)
                DeviceDefinitionRow(label: "Last seen", value: device.lastSeenAt.formatted(.relative(presentation: .numeric)))
            }
        }
    }

    private var powerConfirmationTitle: String {
        guard let action = pendingPowerAction else { return "Power action" }
        return "\(powerActionLabel(action)) \(device?.name ?? "device")?"
    }

    private func powerActionLabel(_ action: FleetPowerAction) -> String {
        switch action {
        case .wake: "Wake"
        case .sleep: "Sleep"
        case .restart: "Restart"
        case .shutdown: "Shut Down"
        case .lock: "Lock"
        case .logout: "Log Out"
        }
    }

    private func performPowerAction(_ action: FleetPowerAction) async {
        actionInProgress = true
        pendingPowerAction = nil
        await store.power(deviceID: deviceID, action: action)
        actionInProgress = false
    }
}

private struct DeviceListCard: View {
    let device: FleetDevice

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 13) {
                    FleetDeviceGlyph(role: device.role, size: 46)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name)
                            .font(.headline.weight(.semibold))
                            .lineLimit(1)
                        Text("\(device.osName) · \(device.arch)")
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 3)
                    FleetMobileStatusPill(
                        text: device.presence?.label ?? device.status.displayName,
                        tone: device.presence?.summary.tone ?? device.status.tone
                    )
                }

                HStack(spacing: 14) {
                    FleetMobileMetricBar(
                        label: "CPU",
                        value: device.metrics.cpu.usagePercent
                    )
                    FleetMobileMetricBar(
                        label: "RAM",
                        value: device.metrics.memory.usagePercent,
                        tint: MobileFleetPalette.purple
                    )
                }

                HStack(spacing: 12) {
                    Label("\(device.activeJobIds.count) jobs", systemImage: "bolt")
                    if let gpu = device.metrics.gpus.first, let usage = gpu.usagePercent {
                        Label("\(Int(usage.rounded()))% GPU", systemImage: "gauge.with.dots.needle.67percent")
                    }
                    Spacer()
                    Text(device.lastSeenAt, style: .relative)
                }
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
                .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens device details")
    }
}

private struct DeviceSummaryStat: View {
    let value: String
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(color)
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private struct DeviceFilterChip: View {
    let title: String
    let selected: Bool
    var tone: FleetMobileTone = .cyan
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(selected ? tone.color : MobileFleetPalette.secondaryText)
                .padding(.horizontal, 13)
                .frame(minHeight: 38)
                .background(
                    selected ? tone.color.opacity(0.12) : MobileFleetPalette.panel,
                    in: Capsule()
                )
                .overlay {
                    Capsule().stroke(selected ? tone.color.opacity(0.5) : MobileFleetPalette.border, lineWidth: 1)
                }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct DeviceMiniMetric: View {
    let icon: String
    let value: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon)
                .foregroundStyle(MobileFleetPalette.cyan)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct DeviceDefinitionRow: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(MobileFleetPalette.mutedText)
            Spacer(minLength: 12)
            Text(value)
                .font(monospaced ? .caption.monospaced() : .subheadline)
                .foregroundStyle(MobileFleetPalette.secondaryText)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                proposal: .unspecified
            )
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var points: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            lineHeight = max(lineHeight, size.height)
            x += size.width + spacing
        }

        return (CGSize(width: maxWidth.isFinite ? maxWidth : x, height: y + lineHeight), points)
    }
}
