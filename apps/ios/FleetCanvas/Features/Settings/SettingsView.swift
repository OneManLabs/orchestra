import SwiftUI
@preconcurrency import AVFoundation

struct SettingsView: View {
    @Environment(FleetStore.self) private var store
    @AppStorage(FleetLocalPreferences.showInAppNoticesKey) private var showInAppNotices = true
    @AppStorage(FleetLocalPreferences.approvalHapticsKey) private var approvalHaptics = true
    @AppStorage(FleetLocalPreferences.sensitivePreviewsKey) private var sensitivePreviews = false

    @State private var showingDisconnectConfirmation = false
    @State private var showingConnectionEditor = false

    var body: some View {
        List {
            connectionSection
            preferencesSection
            fleetSection
            securitySection
            aboutSection
        }
        .scrollContentBackground(.hidden)
        .background(MobileFleetPalette.background)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: $showingConnectionEditor) {
            OnboardingView(showsDismissButton: true)
        }
        .confirmationDialog(
            "Disconnect from Orchestra Core?",
            isPresented: $showingDisconnectConfirmation,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                store.disconnect()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The API token will be removed from this iPhone’s Keychain. Your fleet keeps running.")
        }
        .fleetMobileBackground()
    }

    private var connectionSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "network")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(store.connectionState.isConnected ? MobileFleetPalette.green : MobileFleetPalette.red)
                    .frame(width: 40, height: 40)
                    .background(
                        (store.connectionState.isConnected ? MobileFleetPalette.green : MobileFleetPalette.red).opacity(0.1),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: 4) {
                    Text(store.connectionState.isConnected ? "Core connected" : "Core unavailable")
                        .font(.subheadline.weight(.semibold))
                    Text(store.snapshot?.settings.coreUrl ?? "No endpoint configured")
                        .font(.caption.monospaced())
                        .foregroundStyle(MobileFleetPalette.mutedText)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 4)

            Button {
                Task { await store.refresh() }
            } label: {
                SettingsActionRow(
                    icon: "arrow.clockwise",
                    title: store.isRefreshing ? "Refreshing…" : "Refresh now",
                    detail: "Reload devices, jobs, alerts, and sessions"
                )
            }
            .disabled(store.isRefreshing)

            Button {
                showingConnectionEditor = true
            } label: {
                SettingsActionRow(
                    icon: "link.badge.plus",
                    title: "Change Orchestra Core",
                    detail: "Scan a QR code or enter another endpoint"
                )
            }

            Button(role: .destructive) {
                showingDisconnectConfirmation = true
            } label: {
                Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(minHeight: 44)
            }
            .disabled(!store.connectionState.isConnected && store.snapshot == nil)
        } header: {
            Text("Connection")
        } footer: {
            Text("Orchestra credentials are stored locally in the iOS Keychain and sent only to your configured Core.")
        }
        .listRowBackground(MobileFleetPalette.panel)
    }

    private var preferencesSection: some View {
        Section("iPhone controls") {
            Toggle(isOn: $showInAppNotices) {
                SettingsToggleLabel(
                    icon: "bell",
                    title: "Show in-app notices",
                    detail: "Display Orchestra Core notices in the Attention inbox"
                )
            }
            .tint(MobileFleetPalette.cyan)

            Toggle(isOn: $approvalHaptics) {
                SettingsToggleLabel(
                    icon: "hand.tap",
                    title: "Approval haptics",
                    detail: "Confirm important decisions with feedback"
                )
            }
            .tint(MobileFleetPalette.cyan)

            Toggle(isOn: $sensitivePreviews) {
                SettingsToggleLabel(
                    icon: "eye",
                    title: "Inbox sensitive previews",
                    detail: "Show command and project details in Attention"
                )
            }
            .tint(MobileFleetPalette.cyan)
        }
        .listRowBackground(MobileFleetPalette.panel)
    }

    private var fleetSection: some View {
        Section("Orchestra Core") {
            SettingsValueRow(label: "Orchestra", value: store.snapshot?.settings.fleetName ?? "—")
            SettingsValueRow(label: "Devices", value: "\(store.devices.count)")
            SettingsValueRow(label: "Core version", value: store.snapshot?.version ?? "—")
            SettingsValueRow(
                label: "Protocol",
                value: store.snapshot.map { "v\($0.v2.protocolVersion)" } ?? "—"
            )
            SettingsValueRow(
                label: "Schema",
                value: store.snapshot.map { "v\($0.v2.schemaVersion)" } ?? "—"
            )
        }
        .listRowBackground(MobileFleetPalette.panel)
    }

    private var securitySection: some View {
        Section("Security") {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(MobileFleetPalette.green)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Keychain protected")
                        .font(.subheadline.weight(.semibold))
                    Text("Credentials never appear in Orchestra snapshots or logs")
                        .font(.caption)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }
            }
            .padding(.vertical, 4)

            HStack(spacing: 12) {
                Image(systemName: "lock.shield.fill")
                    .foregroundStyle(MobileFleetPalette.cyan)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Least-privilege approvals")
                        .font(.subheadline.weight(.semibold))
                    Text("Destructive actions still require Orchestra policy authorization")
                        .font(.caption)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(MobileFleetPalette.panel)
    }

    private var aboutSection: some View {
        Section("About") {
            SettingsValueRow(label: "App", value: "Orchestra")
            SettingsValueRow(
                label: "Version",
                value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
            )
            SettingsValueRow(
                label: "Build",
                value: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
            )
        }
        .listRowBackground(MobileFleetPalette.panel)
    }
}

struct OnboardingView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(FleetStore.self) private var store

    let showsDismissButton: Bool

    @State private var coreURL = ""
    @State private var token = ""
    @State private var showingScanner = false
    @State private var isConnecting = false
    @State private var localError: String?

    init(showsDismissButton: Bool = false) {
        self.showsDismissButton = showsDismissButton
    }

    private var canConnect: Bool {
        !coreURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !isConnecting
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    onboardingHero
                    connectionCard
                    trustCard
                }
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 36)
            }
            .navigationTitle(showsDismissButton ? "Connect" : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsDismissButton {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .frame(minHeight: 44)
                    }
                }
            }
            .sheet(isPresented: $showingScanner) {
                FleetQRScannerSheet { value in
                    applyScannedValue(value)
                    showingScanner = false
                }
            }
            .fleetMobileBackground()
        }
    }

    private var onboardingHero: some View {
        VStack(spacing: 17) {
            ZStack {
                RoundedRectangle(cornerRadius: 23, style: .continuous)
                    .fill(FleetTheme.blueGradient)
                Image(systemName: "command")
                    .font(.system(size: 36, weight: .bold))
                    .foregroundStyle(MobileFleetPalette.background)
            }
            .frame(width: 78, height: 78)
            .shadow(color: MobileFleetPalette.cyan.opacity(0.28), radius: 28, y: 12)
            .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text("Orchestra")
                    .font(.largeTitle.weight(.bold))
                    .tracking(-1.2)
                Text("Your fleet, always within reach.")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                Text("Connect privately to Orchestra Core over Tailscale to monitor devices, approve Codex actions, and dispatch work from your iPhone.")
                    .font(.subheadline)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
        }
    }

    private var connectionCard: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 17) {
                FleetMobileSectionHeader(title: "Connect to Orchestra Core", detail: "Use the private Core address and a scoped token")

                Button {
                    showingScanner = true
                } label: {
                    Label("Scan connection QR code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(FleetSecondaryButtonStyle())

                HStack {
                    Rectangle().fill(MobileFleetPalette.border).frame(height: 1)
                    Text("OR ENTER MANUALLY")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.1)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                        .fixedSize()
                    Rectangle().fill(MobileFleetPalette.border).frame(height: 1)
                }

                VStack(alignment: .leading, spacing: 7) {
                    Label("Core URL", systemImage: "server.rack")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MobileFleetPalette.secondaryText)
                    TextField("https://fleet-core.tailnet.ts.net", text: $coreURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .padding(.horizontal, 12)
                        .frame(minHeight: 48)
                        .background(MobileFleetPalette.background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .stroke(MobileFleetPalette.border, lineWidth: 1)
                        }
                }

                VStack(alignment: .leading, spacing: 7) {
                    Label("Access token", systemImage: "key.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(MobileFleetPalette.secondaryText)
                    SecureField("Scoped API or recovery token", text: $token)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .padding(.horizontal, 12)
                        .frame(minHeight: 48)
                        .background(MobileFleetPalette.background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .stroke(MobileFleetPalette.border, lineWidth: 1)
                        }
                }

                if let error = localError ?? store.lastError {
                    FleetInlineError(message: error)
                }

                Button {
                    Task { await connect() }
                } label: {
                    HStack(spacing: 9) {
                        if isConnecting {
                            ProgressView().tint(MobileFleetPalette.background)
                        }
                        Text(isConnecting ? "Connecting securely…" : "Connect securely")
                    }
                }
                .buttonStyle(FleetPrimaryButtonStyle())
                .disabled(!canConnect)
            }
        }
    }

    private var trustCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "lock.shield.fill")
                .font(.title3)
                .foregroundStyle(MobileFleetPalette.green)
            VStack(alignment: .leading, spacing: 5) {
                Text("Private by design")
                    .font(.subheadline.weight(.semibold))
                Text("Orchestra Canvas does not discover public servers. Use your Tailscale DNS name or 100.x address, and keep Core administrative panels off the public internet.")
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 6)
    }

    private func connect() async {
        localError = nil
        do {
            _ = try FleetCoreOrigin(coreURL)
        } catch {
            localError = error.localizedDescription
            return
        }

        isConnecting = true
        let connected = await store.connect(
            coreURL: coreURL.trimmingCharacters(in: .whitespacesAndNewlines),
            token: token.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        isConnecting = false

        if connected, showsDismissButton {
            dismiss()
        }
    }

    private func applyScannedValue(_ value: String) {
        localError = nil

        switch parseFleetEnrollmentQRCode(value) {
        case let .connection(scannedCoreURL, scannedToken):
            coreURL = scannedCoreURL
            token = scannedToken
        case let .coreURLOnly(scannedCoreURL):
            coreURL = scannedCoreURL
            localError = "For security, URL QR codes fill only the Core address. Enter the access token manually or scan an Orchestra JSON QR code."
        case .invalid:
            localError = "Scan an Orchestra JSON connection code containing coreUrl and token, or enter the connection manually."
        }
    }
}

private struct FleetQRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onScan: (String) -> Void

    @State private var permissionDenied = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                if permissionDenied {
                    VStack(spacing: 14) {
                        Image(systemName: "camera.fill")
                            .font(.largeTitle)
                            .foregroundStyle(MobileFleetPalette.amber)
                        Text("Camera access is off")
                            .font(.title3.weight(.bold))
                        Text("Allow camera access in Settings to scan an Orchestra connection QR code.")
                            .font(.subheadline)
                            .foregroundStyle(MobileFleetPalette.secondaryText)
                            .multilineTextAlignment(.center)
                        if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                            Link("Open Settings", destination: settingsURL)
                                .buttonStyle(FleetPrimaryButtonStyle())
                                .padding(.top, 4)
                        }
                    }
                    .padding(28)
                } else {
                    FleetQRScannerView(
                        onScan: onScan,
                        onPermissionDenied: { permissionDenied = true }
                    )
                    scannerOverlay
                }
            }
            .navigationTitle("Scan Orchestra QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .frame(minHeight: 44)
                }
            }
            .toolbarBackground(.black.opacity(0.72), for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
    }

    private var scannerOverlay: some View {
        VStack {
            Spacer()
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(MobileFleetPalette.cyanBright, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: 260, height: 260)
                .shadow(color: MobileFleetPalette.cyan.opacity(0.55), radius: 12)
                .accessibilityHidden(true)
            Spacer()
            Text("Center the connection QR code in the frame")
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)
                .frame(minHeight: 48)
                .background(.black.opacity(0.66), in: Capsule())
                .padding(.bottom, 34)
        }
        .allowsHitTesting(false)
    }
}

private struct FleetQRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onPermissionDenied: () -> Void

    func makeUIViewController(context: Context) -> FleetQRScannerController {
        let controller = FleetQRScannerController()
        controller.onScan = onScan
        controller.onPermissionDenied = onPermissionDenied
        return controller
    }

    func updateUIViewController(_ uiViewController: FleetQRScannerController, context: Context) {}
}

@MainActor
private final class FleetQRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onPermissionDenied: (() -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasScanned = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureAuthorization()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            Task.detached { [session] in session.stopRunning() }
        }
    }

    private func configureAuthorization() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    if granted {
                        self?.configureSession()
                    } else {
                        self?.onPermissionDenied?()
                    }
                }
            }
        default:
            onPermissionDenied?()
        }
    }

    private func configureSession() {
        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            onPermissionDenied?()
            return
        }

        session.beginConfiguration()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            onPermissionDenied?()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        session.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        Task.detached { [session] in session.startRunning() }
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        Task { @MainActor [weak self] in
            guard let self, !hasScanned else { return }
            hasScanned = true
            if session.isRunning {
                Task.detached { [session] in session.stopRunning() }
            }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            onScan?(value)
        }
    }
}

private struct SettingsActionRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(MobileFleetPalette.cyan)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(MobileFleetPalette.primaryText)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(MobileFleetPalette.mutedText)
        }
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsToggleLabel: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(MobileFleetPalette.cyan)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(MobileFleetPalette.mutedText)
            }
        }
        .padding(.vertical, 3)
    }
}

private struct SettingsValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(MobileFleetPalette.secondaryText)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(MobileFleetPalette.mutedText)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}
