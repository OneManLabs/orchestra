import SwiftUI

enum MobileFleetPalette {
    static let background = FleetTheme.background
    static let panel = FleetTheme.panel
    static let raisedPanel = FleetTheme.panelElevated
    static let border = FleetTheme.border
    static let softBorder = FleetTheme.borderSoft
    static let primaryText = FleetTheme.textPrimary
    static let secondaryText = FleetTheme.textSecondary
    static let mutedText = FleetTheme.textMuted
    static let cyan = FleetTheme.blue
    static let cyanBright = Color(hex: 0x54CFF8)
    static let green = FleetTheme.healthy
    static let amber = FleetTheme.warning
    static let red = FleetTheme.critical
    static let purple = FleetTheme.automation
}

struct FleetChatComposerInput: View {
    let placeholder: String
    let accessibilityIdentifier: String
    @Binding var text: String
    var focus: FocusState<Bool>.Binding

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...7)
            .focused(focus)
            .accessibilityIdentifier(accessibilityIdentifier)
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(
                MobileFleetPalette.raisedPanel,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(
                        focus.wrappedValue
                            ? MobileFleetPalette.cyan.opacity(0.7)
                            : MobileFleetPalette.border,
                        lineWidth: 1
                    )
            }
            .keyboardType(.default)
            .textInputAutocapitalization(.sentences)
            .autocorrectionDisabled(false)
            .submitLabel(.return)
            .accessibilityHint("Return inserts a line break. Use the send button to send the message.")
    }
}

struct FleetChatSendButton: View {
    let isSending: Bool
    let canSend: Bool
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isSending {
                    ProgressView().tint(MobileFleetPalette.background)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                }
            }
            .foregroundStyle(MobileFleetPalette.background)
            .frame(width: 46, height: 46)
            .background(
                canSend ? MobileFleetPalette.cyanBright : MobileFleetPalette.border,
                in: Circle()
            )
        }
        .disabled(!canSend)
        .accessibilityLabel(accessibilityLabel)
        .keyboardShortcut(.return, modifiers: .command)
    }
}

struct FleetChatStopButton: View {
    let isStopping: Bool
    let canStop: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isStopping {
                    ProgressView().tint(MobileFleetPalette.red)
                } else {
                    Image(systemName: "stop.fill")
                        .font(.caption.weight(.bold))
                }
            }
            .foregroundStyle(MobileFleetPalette.red)
            .frame(width: 46, height: 46)
            .background(MobileFleetPalette.red.opacity(0.1), in: Circle())
            .overlay {
                Circle().stroke(MobileFleetPalette.red.opacity(0.38), lineWidth: 1)
            }
        }
        .disabled(!canStop)
        .accessibilityLabel("Stop Codex response")
    }
}

private struct FleetChatTranscriptBehavior: ViewModifier {
    let scrollRequest: Int
    let contentVersion: Date?

    @State private var position = ScrollPosition(edge: .bottom)
    @State private var isNearBottom = true
    @State private var followsBottom = true
    @State private var phase: ScrollPhase = .idle

    func body(content: Content) -> some View {
        content
            .scrollDismissesKeyboard(.interactively)
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 80
            } action: { _, isNearBottom in
                self.isNearBottom = isNearBottom
                if phase != .idle {
                    followsBottom = isNearBottom
                }
            }
            .onScrollPhaseChange { _, newPhase in
                phase = newPhase
                if newPhase == .idle {
                    followsBottom = isNearBottom
                }
            }
            .onChange(of: contentVersion) {
                scrollToBottomIfFollowing(animated: false)
            }
            .onChange(of: scrollRequest) {
                guard scrollRequest > 0 else { return }
                scrollToBottomIfFollowing(animated: true)
            }
    }

    private func scrollToBottomIfFollowing(animated: Bool) {
        guard followsBottom else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.22)) {
                position.scrollTo(edge: .bottom)
            }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                position.scrollTo(edge: .bottom)
            }
        }
    }
}

extension View {
    func fleetChatTranscriptBehavior(scrollRequest: Int = 0, contentVersion: Date? = nil) -> some View {
        modifier(FleetChatTranscriptBehavior(scrollRequest: scrollRequest, contentVersion: contentVersion))
    }
}

func fleetChatDraftContainsSendableText(_ draft: String) -> Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

func restoredFleetChatDraftAfterFailedSend(sent: String, current: String) -> String {
    current.isEmpty ? sent : "\(sent)\n\n\(current)"
}

struct FleetMobileBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .foregroundStyle(MobileFleetPalette.primaryText)
            .background {
                ZStack {
                    MobileFleetPalette.background.ignoresSafeArea()
                    RadialGradient(
                        colors: [MobileFleetPalette.cyan.opacity(0.075), .clear],
                        center: .topTrailing,
                        startRadius: 0,
                        endRadius: 390
                    )
                    .ignoresSafeArea()
                }
            }
            .toolbarBackground(MobileFleetPalette.background.opacity(0.94), for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}

extension View {
    func fleetMobileBackground() -> some View {
        modifier(FleetMobileBackground())
    }
}

struct FleetMobileCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [MobileFleetPalette.raisedPanel, MobileFleetPalette.panel],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(MobileFleetPalette.border.opacity(0.88), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }
}

struct FleetMobileSectionHeader: View {
    let title: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(MobileFleetPalette.primaryText)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }
            }

            Spacer(minLength: 8)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                    .frame(minHeight: 44)
            }
        }
    }
}

struct FleetMobileStatusPill: View {
    let text: String
    let tone: FleetMobileTone

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(tone.color)
                .frame(width: 6, height: 6)
                .shadow(color: tone.color.opacity(0.6), radius: 5)
            Text(text)
                .lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, 9)
        .frame(minHeight: 26)
        .background(tone.color.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(tone.color.opacity(0.34), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

enum FleetMobileTone {
    case neutral, cyan, green, amber, red, purple

    var color: Color {
        switch self {
        case .neutral: MobileFleetPalette.mutedText
        case .cyan: MobileFleetPalette.cyan
        case .green: MobileFleetPalette.green
        case .amber: MobileFleetPalette.amber
        case .red: MobileFleetPalette.red
        case .purple: MobileFleetPalette.purple
        }
    }

    var foreground: Color {
        switch self {
        case .neutral: MobileFleetPalette.secondaryText
        default: color
        }
    }
}

struct FleetMobileMetricBar: View {
    let label: String
    let value: Double
    var valueLabel: String?
    var tint: Color = MobileFleetPalette.cyan

    var normalizedValue: Double {
        min(max(value, 0), 100)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                Spacer()
                Text(valueLabel ?? "\(Int(normalizedValue.rounded()))%")
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .monospacedDigit()
            }
            .font(.caption)

            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(MobileFleetPalette.border)
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [tint.opacity(0.72), tint],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: proxy.size.width * normalizedValue / 100)
                }
            }
            .frame(height: 5)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(valueLabel ?? "\(Int(normalizedValue.rounded())) percent")
    }
}

struct FleetMobileEmptyState: View {
    let icon: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 23, weight: .medium))
                .foregroundStyle(MobileFleetPalette.cyanBright)
                .frame(width: 50, height: 50)
                .background(MobileFleetPalette.cyan.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            Text(title)
                .font(.headline.weight(.semibold))
                .multilineTextAlignment(.center)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(MobileFleetPalette.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(FleetPrimaryButtonStyle())
                    .padding(.top, 3)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 28)
        .frame(maxWidth: .infinity)
    }
}

struct FleetDangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(MobileFleetPalette.red)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(MobileFleetPalette.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(MobileFleetPalette.red.opacity(0.35), lineWidth: 1)
            }
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct FleetDeviceGlyph: View {
    let role: FleetDeviceRole
    var size: CGFloat = 42

    var body: some View {
        Image(systemName: role.symbolName)
            .font(.system(size: size * 0.40, weight: .semibold))
            .foregroundStyle(role.tint)
            .frame(width: size, height: size)
            .background(role.tint.opacity(0.10), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                    .stroke(role.tint.opacity(0.24), lineWidth: 1)
            }
            .accessibilityHidden(true)
    }
}

extension FleetDeviceRole {
    var displayName: String {
        switch self {
        case .core: "Core"
        case .gpu: "GPU"
        case .worker: "Worker"
        case .gateway: "Gateway"
        case .storage: "Storage"
        case .workstation: "Workstation"
        case .phone: "Phone"
        case .unknown: "Device"
        }
    }

    var symbolName: String {
        switch self {
        case .core: "sparkles"
        case .gpu: "gauge.with.dots.needle.67percent"
        case .worker: "cpu"
        case .gateway: "network"
        case .storage: "externaldrive.fill"
        case .workstation: "desktopcomputer"
        case .phone: "iphone"
        case .unknown: "server.rack"
        }
    }

    var tint: Color {
        switch self {
        case .core: MobileFleetPalette.cyan
        case .gpu: MobileFleetPalette.purple
        case .worker: MobileFleetPalette.cyanBright
        case .gateway: MobileFleetPalette.green
        case .storage: MobileFleetPalette.green
        case .workstation: MobileFleetPalette.amber
        case .phone: MobileFleetPalette.cyan
        case .unknown: MobileFleetPalette.mutedText
        }
    }
}

extension FleetDeviceStatus {
    var displayName: String { rawValue.replacingOccurrences(of: "-", with: " ").capitalized }

    var tone: FleetMobileTone {
        switch self {
        case .online: .green
        case .busy: .cyan
        case .degraded: .amber
        case .offline: .neutral
        }
    }
}

extension FleetDevicePresenceSummary {
    var tone: FleetMobileTone {
        switch self {
        case .operational: .green
        case .degraded, .agentOffline: .amber
        case .hostUnreachable: .red
        case .unknown: .neutral
        }
    }
}

extension FleetDevicePresenceLayerState {
    var tone: FleetMobileTone {
        switch self {
        case .reachable: .green
        case .unreachable: .red
        case .stale: .amber
        case .unknown, .notConfigured: .neutral
        }
    }
}

extension FleetJobStatus {
    var displayName: String { rawValue.replacingOccurrences(of: "-", with: " ").capitalized }

    var tone: FleetMobileTone {
        switch self {
        case .queued, .awaitingApproval: .amber
        case .dispatching, .running: .cyan
        case .completed: .green
        case .failed: .red
        case .cancelled: .neutral
        }
    }

    var isActive: Bool {
        self == .dispatching || self == .running || self == .awaitingApproval
    }
}

extension CodexSessionStatus {
    var displayName: String {
        switch self {
        case .completed: "Turn complete"
        default: rawValue.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    var tone: FleetMobileTone {
        switch self {
        case .starting, .thinking: .cyan
        case .ready, .completed: .green
        case .awaitingApproval: .amber
        case .error: .red
        case .stopped: .neutral
        }
    }
}

extension FleetAlertSeverity {
    var displayName: String { rawValue.capitalized }

    var tone: FleetMobileTone {
        switch self {
        case .info: .cyan
        case .warning: .amber
        case .critical: .red
        }
    }
}

extension FleetPermissionMode {
    var displayName: String {
        switch self {
        case .readOnly: "Read only"
        case .workspaceWrite: "Workspace write"
        case .dangerFullAccess: "Full access"
        }
    }
}

enum FleetMobileFormatter {
    static func bytes(_ value: Double) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .memory
        formatter.allowedUnits = [.useGB, .useTB, .useMB]
        formatter.includesUnit = true
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: Int64(value))
    }

    static func duration(_ seconds: Double) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = seconds >= 3_600 ? [.hour, .minute] : [.minute, .second]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        return formatter.string(from: max(0, seconds)) ?? "—"
    }
}

struct FleetLoadingOverlay: View {
    let title: String

    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .tint(MobileFleetPalette.cyan)
                .controlSize(.large)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(MobileFleetPalette.secondaryText)
        }
        .padding(28)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct FleetInlineError: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(MobileFleetPalette.red)
                .padding(.top, 2)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(MobileFleetPalette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let retry {
                Button("Retry", action: retry)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(MobileFleetPalette.cyanBright)
                    .frame(minHeight: 44)
            }
        }
        .padding(13)
        .background(MobileFleetPalette.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(MobileFleetPalette.red.opacity(0.30), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}
