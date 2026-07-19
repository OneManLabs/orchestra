import SwiftUI

struct JobsView: View {
    @Environment(FleetStore.self) private var store
    @State private var query = ""
    @State private var filter: JobFilter = .active
    @State private var showingNewJob = false

    private var jobs: [FleetJob] {
        store.orderedJobs
            .filter(filter.includes)
            .filter {
                query.isEmpty ||
                    $0.name.localizedCaseInsensitiveContains(query) ||
                    $0.prompt.localizedCaseInsensitiveContains(query) ||
                    ($0.command?.localizedCaseInsensitiveContains(query) ?? false)
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

                    jobSummary
                    filterPicker

                    if jobs.isEmpty {
                        FleetMobileCard {
                            FleetMobileEmptyState(
                                icon: store.jobs.isEmpty ? "shippingbox" : "line.3.horizontal.decrease.circle",
                                title: store.jobs.isEmpty ? "No jobs yet" : "No jobs in this view",
                                message: store.jobs.isEmpty
                                    ? "Dispatch a Codex task or shell command to any enrolled device."
                                    : "Choose a different filter or clear your search.",
                                actionTitle: store.jobs.isEmpty ? "Create first job" : nil
                            ) {
                                showingNewJob = true
                            }
                        }
                    } else {
                        ForEach(jobs) { job in
                            NavigationLink {
                                JobDetailView(jobID: job.id)
                            } label: {
                                JobListCard(job: job, device: store.devices.first { $0.id == job.deviceId })
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
            .navigationTitle("Jobs")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, prompt: "Search jobs")
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

    private var jobSummary: some View {
        FleetMobileCard {
            HStack(spacing: 0) {
                JobSummaryStat(
                    value: "\(store.jobs.filter { $0.status.isActive }.count)",
                    label: "Active",
                    tone: .cyan
                )
                Divider().overlay(MobileFleetPalette.border)
                JobSummaryStat(
                    value: "\(store.jobs.filter { $0.status == .queued }.count)",
                    label: "Queued",
                    tone: .amber
                )
                Divider().overlay(MobileFleetPalette.border)
                JobSummaryStat(
                    value: "\(store.jobs.filter { $0.status == .completed }.count)",
                    label: "Complete",
                    tone: .green
                )
                Divider().overlay(MobileFleetPalette.border)
                JobSummaryStat(
                    value: "\(store.jobs.filter { $0.status == .failed }.count)",
                    label: "Failed",
                    tone: .red
                )
            }
            .frame(height: 48)
        }
    }

    private var filterPicker: some View {
        Picker("Job status", selection: $filter) {
            ForEach(JobFilter.allCases) { item in
                Text(item.title).tag(item)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Filter jobs")
    }
}

struct JobDetailView: View {
    @Environment(FleetStore.self) private var store
    let jobID: String

    @State private var showingCancelConfirmation = false
    @State private var actionInProgress = false

    private var job: FleetJob? {
        store.jobs.first { $0.id == jobID }
    }

    private var device: FleetDevice? {
        guard let deviceID = job?.deviceId else { return nil }
        return store.devices.first { $0.id == deviceID }
    }

    private var project: FleetProject? {
        guard let projectID = job?.projectId else { return nil }
        return store.projects.first { $0.id == projectID }
    }

    var body: some View {
        ScrollView {
            if let job {
                LazyVStack(spacing: 16) {
                    jobHero(job)
                    instructionsCard(job)
                    liveOutputCard(job)
                    executionCard(job)

                    if let error = job.error {
                        FleetInlineError(message: error)
                    }

                    actionCard(job)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 30)
            } else {
                FleetMobileEmptyState(
                    icon: "questionmark.folder",
                    title: "Job unavailable",
                    message: "This job is no longer present in the current Orchestra snapshot."
                )
                .padding(16)
            }
        }
        .refreshable { await store.refresh() }
        .navigationTitle(job?.name ?? "Job")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Cancel \(job?.name ?? "job")?",
            isPresented: $showingCancelConfirmation,
            titleVisibility: .visible
        ) {
            Button("Cancel Job", role: .destructive) {
                Task {
                    actionInProgress = true
                    await store.cancelJob(jobID)
                    actionInProgress = false
                }
            }
            Button("Keep Running", role: .cancel) {}
        } message: {
            Text("The remote process will be asked to stop. Partial output remains in the job record.")
        }
        .fleetMobileBackground()
    }

    private func jobHero(_ job: FleetJob) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 13) {
                    Image(systemName: job.kind == .codex ? "sparkles" : "terminal")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan)
                        .frame(width: 48, height: 48)
                        .background(
                            (job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan).opacity(0.11),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 4) {
                        Text(job.name)
                            .font(.headline.weight(.bold))
                        Text(job.kind == .codex ? "Codex job" : "Shell job")
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }

                    Spacer()
                    FleetMobileStatusPill(text: job.status.displayName, tone: job.status.tone)
                }

                if let progress = job.progress {
                    FleetMobileMetricBar(
                        label: job.phase ?? "Progress",
                        value: progress
                    )
                } else if let phase = job.phase {
                    Label(phase, systemImage: "waveform.path.ecg")
                        .font(.subheadline)
                        .foregroundStyle(MobileFleetPalette.secondaryText)
                }
            }
        }
    }

    private func instructionsCard(_ job: FleetJob) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 12) {
                FleetMobileSectionHeader(title: job.kind == .codex ? "Instructions" : "Command")

                Text(job.kind == .codex ? job.prompt : (job.command ?? ""))
                    .font(job.kind == .codex ? .body : .callout.monospaced())
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                if !job.requiredLabels.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(job.requiredLabels, id: \.self) { label in
                            Text(label)
                                .font(.caption2.monospaced())
                                .foregroundStyle(MobileFleetPalette.cyan)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(MobileFleetPalette.cyan.opacity(0.08), in: Capsule())
                        }
                    }
                }
            }
        }
    }

    private func liveOutputCard(_ job: FleetJob) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 12) {
                FleetMobileSectionHeader(
                    title: "Output",
                    detail: "\(job.output.count) events"
                )

                if job.output.isEmpty {
                    HStack(spacing: 10) {
                        if job.status.isActive || job.status == .queued {
                            ProgressView().tint(MobileFleetPalette.cyan)
                        } else {
                            Image(systemName: "terminal")
                                .foregroundStyle(MobileFleetPalette.mutedText)
                        }
                        Text(job.status.isActive || job.status == .queued ? "Waiting for output…" : "No output was recorded.")
                            .font(.subheadline)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                    }
                    .frame(minHeight: 50)
                } else {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(job.output.suffix(100)) { event in
                            JobOutputRow(event: event)
                        }
                    }
                }
            }
        }
    }

    private func executionCard(_ job: FleetJob) -> some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 13) {
                FleetMobileSectionHeader(title: "Execution")
                JobDefinitionRow(label: "Target", value: device?.name ?? "Automatic")
                JobDefinitionRow(label: "Project", value: project?.name ?? "No project")
                JobDefinitionRow(label: "Workspace", value: job.cwd ?? "Default", monospaced: true)
                JobDefinitionRow(label: "Permission", value: job.permissionMode.displayName)
                JobDefinitionRow(label: "Approval", value: job.approvalPolicy.rawValue.replacingOccurrences(of: "-", with: " ").capitalized)
                JobDefinitionRow(label: "Created", value: job.createdAt.formatted(date: .abbreviated, time: .shortened))
                if let startedAt = job.startedAt {
                    JobDefinitionRow(label: "Started", value: startedAt.formatted(date: .abbreviated, time: .shortened))
                }
                if let completedAt = job.completedAt {
                    JobDefinitionRow(label: "Completed", value: completedAt.formatted(date: .abbreviated, time: .shortened))
                }
                if let exitCode = job.exitCode {
                    JobDefinitionRow(label: "Exit code", value: "\(exitCode)", monospaced: true)
                }
            }
        }
    }

    @ViewBuilder
    private func actionCard(_ job: FleetJob) -> some View {
        if job.status.isActive || job.status == .queued || job.status == .failed || job.status == .cancelled {
            FleetMobileCard {
                VStack(spacing: 10) {
                    if job.status == .failed || job.status == .cancelled || job.status == .queued {
                        Button {
                            Task {
                                actionInProgress = true
                                await store.retryJob(job.id)
                                actionInProgress = false
                            }
                        } label: {
                            Label(actionInProgress ? "Starting…" : job.status == .queued ? "Start Job" : "Retry Job", systemImage: "play.fill")
                        }
                        .buttonStyle(FleetPrimaryButtonStyle())
                        .disabled(actionInProgress)
                    }

                    if job.status.isActive || job.status == .queued {
                        Button {
                            showingCancelConfirmation = true
                        } label: {
                            Label("Cancel Job", systemImage: "stop.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(FleetDangerButtonStyle())
                        .disabled(actionInProgress)
                    }
                }
            }
        }
    }
}

struct NewJobView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(FleetStore.self) private var store

    @State private var kind: FleetJobKind = .codex
    @State private var name = ""
    @State private var instructions = ""
    @State private var deviceID = ""
    @State private var projectID = ""
    @State private var permission: FleetPermissionMode = .workspaceWrite
    @State private var isSubmitting = false

    private var canSubmit: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !isSubmitting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Job type", selection: $kind) {
                        Label("Codex", systemImage: "sparkles").tag(FleetJobKind.codex)
                        Label("Shell", systemImage: "terminal").tag(FleetJobKind.shell)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(MobileFleetPalette.panel)
                }

                Section("Work") {
                    TextField("Job name", text: $name)
                        .textInputAutocapitalization(.sentences)

                    TextField(
                        kind == .codex ? "Describe the outcome Codex should achieve…" : "Command to run",
                        text: $instructions,
                        axis: .vertical
                    )
                    .lineLimit(5...12)
                    .font(kind == .shell ? .body.monospaced() : .body)
                    .textInputAutocapitalization(kind == .shell ? .never : .sentences)
                    .autocorrectionDisabled(kind == .shell)
                }
                .listRowBackground(MobileFleetPalette.panel)

                Section("Execution") {
                    Picker("Target", selection: $deviceID) {
                        Text("Automatic").tag("")
                        ForEach(store.devices) { device in
                            Text("\(device.name) · \(device.status.displayName)").tag(device.id)
                        }
                    }

                    Picker("Project", selection: $projectID) {
                        Text("No project").tag("")
                        ForEach(store.projects) { project in
                            Text(project.name).tag(project.id)
                        }
                    }

                    Picker("Permissions", selection: $permission) {
                        ForEach(FleetPermissionMode.allCases, id: \.self) { mode in
                            Text(mode.displayName).tag(mode)
                        }
                    }
                }
                .listRowBackground(MobileFleetPalette.panel)

                if permission == .dangerFullAccess {
                    Section {
                        Label(
                            "Full access removes the filesystem sandbox. Use it only on a trusted device.",
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
            .navigationTitle("New Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .frame(minHeight: 44)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Dispatching…" : "Dispatch") {
                        Task { await submit() }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSubmit)
                    .frame(minHeight: 44)
                }
            }
            .fleetMobileBackground()
        }
    }

    private func submit() async {
        isSubmitting = true
        let request = CreateFleetJobRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            kind: kind,
            prompt: kind == .codex ? instructions.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            command: kind == .shell ? instructions.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            deviceId: deviceID.isEmpty ? nil : deviceID,
            projectId: projectID.isEmpty ? nil : projectID,
            permissionMode: permission,
            approvalPolicy: .onRequest
        )
        await store.createJob(request)
        isSubmitting = false
        if store.lastError == nil {
            dismiss()
        }
    }
}

private enum JobFilter: String, CaseIterable, Identifiable {
    case active, queued, completed, failed, all

    var id: Self { self }
    var title: String { rawValue.capitalized }

    func includes(_ job: FleetJob) -> Bool {
        switch self {
        case .active: job.status.isActive
        case .queued: job.status == .queued
        case .completed: job.status == .completed
        case .failed: job.status == .failed
        case .all: true
        }
    }
}

private struct JobSummaryStat: View {
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

private struct JobListCard: View {
    let job: FleetJob
    let device: FleetDevice?

    var body: some View {
        FleetMobileCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: job.kind == .codex ? "sparkles" : "terminal")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan)
                        .frame(width: 40, height: 40)
                        .background(
                            (job.kind == .codex ? MobileFleetPalette.purple : MobileFleetPalette.cyan).opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: 4) {
                        Text(job.name)
                            .font(.headline.weight(.semibold))
                            .lineLimit(1)
                        Text(device?.name ?? "Automatic target")
                            .font(.caption)
                            .foregroundStyle(MobileFleetPalette.mutedText)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)
                    FleetMobileStatusPill(text: job.status.displayName, tone: job.status.tone)
                }

                Text(job.phase ?? (job.kind == .codex ? job.prompt : (job.command ?? "No instructions")))
                    .font(.subheadline)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
                    .lineLimit(2)

                if let progress = job.progress {
                    FleetMobileMetricBar(label: job.phase ?? "Progress", value: progress)
                }

                HStack {
                    Label(job.permissionMode.displayName, systemImage: "lock.shield")
                    Spacer()
                    Text(job.createdAt, style: .relative)
                }
                .font(.caption2)
                .foregroundStyle(MobileFleetPalette.mutedText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens job output and controls")
    }
}

private struct JobOutputRow: View {
    let event: FleetJobOutputEvent

    private var tone: FleetMobileTone {
        switch event.stream {
        case .stderr: .red
        case .codex: .purple
        case .system: .cyan
        case .stdout: .neutral
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Text(event.stream.rawValue.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(tone.color)
                .frame(width: 46, alignment: .leading)
                .padding(.top, 2)
            Text(event.text)
                .font(.caption.monospaced())
                .foregroundStyle(event.stream == .stderr ? MobileFleetPalette.red : MobileFleetPalette.secondaryText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct JobDefinitionRow: View {
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
                .lineLimit(3)
        }
        .accessibilityElement(children: .combine)
    }
}
