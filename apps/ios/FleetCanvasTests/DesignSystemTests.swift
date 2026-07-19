import SwiftUI
import Testing
@testable import FleetCanvas

struct DesignSystemTests {
    @Test
    func fleetToneColorsExist() {
        #expect(FleetTone.allCases.count == 6)
    }

    @Test
    func fleetDeviceMentionComposerFindsAndInsertsTheActiveAlias() {
        let draft = "gpu temps on @demo"
        #expect(fleetDeviceMentionQuery(in: draft)?.query == "demo")
        let suggestion = FleetDeviceMentionSuggestion(
            id: "gpu",
            alias: "demo-gpu",
            label: "Demo GPU",
            detail: "Online · GPU"
        )
        #expect(fleetInsertDeviceMention(suggestion, into: draft) == "gpu temps on @demo-gpu ")
        #expect(fleetDeviceMentionQuery(in: "ask @demo-storage to inspect\nnext line") == nil)
    }

    @Test
    func coreSpacingMeetsTouchGuidance() {
        #expect(FleetTheme.minimumTouchTarget >= 44)
        #expect(FleetTheme.screenPadding == 16)
    }

    @Test
    func codexWorkingDirectoryUsesPathForSelectedDevice() {
        let paths = [
            FleetProjectPath(deviceId: "mac", path: "/Users/example/project"),
            FleetProjectPath(deviceId: "gpu", path: "D:\\Projects\\fleet"),
        ]

        #expect(
            preferredCodexWorkingDirectory(
                deviceID: "gpu",
                projectPaths: paths,
                deviceProjectRoots: ["D:\\Projects"]
            ) == "D:\\Projects\\fleet"
        )
    }

    @Test
    func codexWorkingDirectoryFallsBackWhenProjectIsClearedOrDeviceChanges() {
        #expect(
            preferredCodexWorkingDirectory(
                deviceID: "gpu",
                projectPaths: nil,
                deviceProjectRoots: ["D:\\Projects"]
            ) == "D:\\Projects"
        )

        #expect(
            preferredCodexWorkingDirectory(
                deviceID: "worker",
                projectPaths: [
                    FleetProjectPath(deviceId: "mac", path: "/Users/example/project"),
                ],
                deviceProjectRoots: ["/Users/example/Projects"]
            ) == "/Users/example/Projects"
        )
    }

    @Test
    func codexMessageActionsFindTurnBoundariesAndOnlyExposeWebSources() {
        let now = Date()
        let user = CodexEvent(id: "user", at: now, type: .user, text: "Look it up", method: nil, data: nil, actor: nil)
        let search = CodexEvent(
            id: "search",
            at: now,
            type: .tool,
            text: "Web search — Fleet docs",
            method: "item/completed",
            data: .object([
                "turnId": .string("turn-web"),
                "item": .object([
                    "type": .string("webSearch"),
                    "query": .string("Fleet docs"),
                    "results": .array([.object([
                        "title": .string("Fleet"),
                        "url": .string("https://fleet.example/docs"),
                    ])]),
                ]),
            ]),
            actor: nil
        )
        let answer = CodexEvent(
            id: "answer",
            at: now,
            type: .assistant,
            text: "See [Fleet docs](https://fleet.example/docs).",
            method: nil,
            data: .object(["turnId": .string("turn-web")]),
            actor: nil
        )

        #expect(codexEventTurnID(answer) == "turn-web")
        #expect(codexMessageSources(for: answer, in: [user, search, answer]) == [
            CodexMessageSource(title: "Fleet docs", url: URL(string: "https://fleet.example/docs")),
        ])

        let local = CodexEvent(
            id: "local",
            at: now,
            type: .assistant,
            text: "See [local docs](https://fleet.example/local).",
            method: nil,
            data: nil,
            actor: nil
        )
        #expect(codexMessageSources(for: local, in: [user, local]).isEmpty)
    }

    @Test
    func codexWorkspacePathsStayInsideTheirSelectedRoot() {
        #expect(fleetWorkspacePath("/Volumes/NAS/repos/fleet", isWithin: "/Volumes/NAS"))
        #expect(fleetWorkspaceParent(of: "/Volumes/NAS/repos/fleet", root: "/Volumes/NAS") == "/Volumes/NAS/repos")
        #expect(fleetWorkspaceParent(of: "/Volumes/NAS", root: "/Volumes/NAS") == nil)
        #expect(fleetWorkspacePath("D:\\Projects\\Fleet", isWithin: "d:\\projects"))
        #expect(fleetWorkspaceJoin("D:\\Projects", "models") == "D:\\Projects\\models")
    }

    @Test
    func codexWorkspaceFolderNamesCannotEscapeTheCurrentDirectory() {
        #expect(fleetWorkspaceFolderNameIsValid("models"))
        #expect(!fleetWorkspaceFolderNameIsValid("../models"))
        #expect(!fleetWorkspaceFolderNameIsValid("nested/models"))
    }

    @Test
    func fleetStatusOrderingMatchesMissionAndFleetViews() {
        let ordered = FleetDeviceStatus.allCases.sorted {
            fleetDeviceStatusRank($0) < fleetDeviceStatusRank($1)
        }
        #expect(ordered == [.busy, .degraded, .online, .offline])
    }

    @Test
    func activeJobDefinitionIsSharedAcrossMissionAndJobsViews() {
        let active = FleetJobStatus.allCases.filter(\.isActive)
        #expect(Set(active) == Set([.dispatching, .running, .awaitingApproval]))
    }

    @Test
    func liveEventsCoalesceBehindOneScheduledRefresh() {
        #expect(shouldScheduleFleetRefresh(hasScheduledRefresh: false))
        #expect(!shouldScheduleFleetRefresh(hasScheduledRefresh: true))
    }

    @Test
    func liveTransportAcceptsFleetSnapshotsBeyondURLSessionsDefaultLimit() {
        #expect(fleetLiveMaximumMessageBytes == 8 * 1_024 * 1_024)
        #expect(fleetLiveMaximumMessageBytes > 1_102_734)
    }

    @Test @MainActor
    func transientLiveDisconnectDoesNotBecomeAGlobalBanner() async {
        let store = FleetStore()

        await store.handle(.disconnected(reason: "The operation couldn’t be completed. Message too long"))

        #expect(store.lastError == nil)
        #expect(store.liveConnectionIssue?.contains("Message too long") == true)
        #expect(store.connectionState == .reconnecting(attempt: 1))

        await store.handle(.connected)
        #expect(store.liveConnectionIssue == nil)
        #expect(store.lastError == nil)
        #expect(store.connectionState == .connected)
    }

    @Test @MainActor
    func systemAndActivityLiveEventsApplyWithoutSnapshotRefresh() async throws {
        let store = FleetStore()
        let now = Date()
        let conversation = FleetSystemConversation(
            id: "system-conversation",
            title: "Fleet System",
            orchestratorDeviceId: "mini64",
            codexSessionId: "system-session",
            status: .thinking,
            activeResponseMessageId: "response",
            error: nil,
            messages: [
                FleetSystemMessage(
                    id: "response",
                    at: now,
                    role: .assistant,
                    text: "Streaming directly",
                    actor: nil,
                    mentions: [],
                    references: [],
                    pendingActionId: nil,
                    conductorPlanId: nil
                ),
            ],
            pendingActions: [],
            conductorPlans: [],
            updatedAt: now
        )
        let conversationPayload = try FleetCoding.decoder.decode(
            JSONValue.self,
            from: FleetCoding.encoder.encode(conversation)
        )

        await store.handle(.event(FleetLiveEvent(type: "system.updated", payload: conversationPayload)))

        #expect(store.systemConversation?.messages.last?.text == "Streaming directly")
        #expect(store.systemConversations.map(\.id) == ["system-conversation"])

        let activity = FleetActivityEvent(
            id: "activity",
            at: now,
            type: .session,
            severity: .success,
            title: "Codex completed",
            detail: "The turn completed.",
            deviceId: "mbp",
            entityId: "session"
        )
        let activityPayload = try FleetCoding.decoder.decode(
            JSONValue.self,
            from: FleetCoding.encoder.encode(activity)
        )

        await store.handle(.event(FleetLiveEvent(type: "activity.created", payload: activityPayload)))

        #expect(store.activity.map(\.id) == ["activity"])
    }

    @Test
    func markdownParserPreservesRichChatStructure() {
        let blocks = fleetMarkdownBlocks("""
        ## Result

        **Healthy** with [details](https://example.com).

        - Agent reachable
        - Preview persistent

        ```swift
        let ready = true
        ```
        """)

        #expect(blocks == [
            .heading(level: 2, text: "Result"),
            .paragraph("**Healthy** with [details](https://example.com)."),
            .unordered(["Agent reachable", "Preview persistent"]),
            .code(language: "swift", text: "let ready = true"),
        ])
    }

    @Test
    func compactCodexLiveUpdatesPreserveEarlierConversationHistory() {
        let now = Date()
        let old = CodexEvent(id: "old", at: now, type: .user, text: "Build it", method: nil, data: nil, actor: nil)
        let partial = CodexEvent(id: "answer", at: now, type: .assistant, text: "Work", method: nil, data: nil, actor: nil)
        let complete = CodexEvent(id: "answer", at: now, type: .assistant, text: "Working now", method: nil, data: nil, actor: nil)
        let session = CodexSession(
            id: "session", deviceId: "device", projectId: nil, cwd: "/fleet", title: "Fleet", kind: nil,
            developerInstructions: nil, threadId: "thread", turnId: "turn", model: nil, permissionMode: .workspaceWrite,
            approvalPolicy: .onRequest, status: .thinking, createdAt: now, updatedAt: now, events: [old, partial],
            pendingApprovals: [], participants: nil, controllerClientId: nil, controllerUpdatedAt: nil, error: nil
        )
        let update = CodexSessionEventUpdate(
            sessionId: "session", event: complete, status: .thinking, updatedAt: now,
            turnId: "turn", error: nil
        )

        #expect(session.applying(update).events.map(\.text) == ["Build it", "Working now"])
    }

    @Test
    func staleCodexProjectionCannotEraseAStreamedResponseOrRegressCompletion() {
        let start = Date(timeIntervalSince1970: 1)
        let completedAt = Date(timeIntervalSince1970: 3)
        let user = CodexEvent(id: "user", at: start, type: .user, text: "Hello", method: nil, data: nil, actor: nil)
        let answer = CodexEvent(id: "answer", at: completedAt, type: .assistant, text: "Hi", method: nil, data: nil, actor: nil)
        let current = CodexSession(
            id: "session", deviceId: "device", projectId: nil, cwd: "/fleet", title: "Fleet", kind: nil,
            developerInstructions: nil, threadId: "thread", turnId: nil, model: nil, permissionMode: .workspaceWrite,
            approvalPolicy: .onRequest, status: .completed, createdAt: start, updatedAt: completedAt, events: [user, answer],
            pendingApprovals: [], participants: nil, controllerClientId: nil, controllerUpdatedAt: nil, error: nil
        )
        let stale = CodexSession(
            id: "session", deviceId: "device", projectId: nil, cwd: "/fleet", title: "Fleet", kind: nil,
            developerInstructions: nil, threadId: "thread", turnId: "old-turn", model: nil, permissionMode: .workspaceWrite,
            approvalPolicy: .onRequest, status: .thinking, createdAt: start, updatedAt: start, events: [user],
            pendingApprovals: [], participants: nil, controllerClientId: nil, controllerUpdatedAt: nil, error: nil
        )

        let merged = current.mergingLiveProjection(stale)
        #expect(merged.status == .completed)
        #expect(merged.turnId == nil)
        #expect(merged.events.map(\.text) == ["Hello", "Hi"])
    }

    @Test
    func backgroundRecoveryOnlyClearsTransientErrors() {
        #expect(shouldClearFleetErrorAfterBackgroundRecovery(.connection))
        #expect(shouldClearFleetErrorAfterBackgroundRecovery(.refresh))
        #expect(!shouldClearFleetErrorAfterBackgroundRecovery(.action))
        #expect(!shouldClearFleetErrorAfterBackgroundRecovery(nil))
    }

    @Test
    func codexTypingPresenceOnlyAdvertisesOnStateTransitions() {
        var state = CodexTypingPresenceState()

        let firstCharacter = state.update(hasText: true)
        #expect(firstCharacter == .started)
        #expect(state.isAdvertised)
        let secondCharacter = state.update(hasText: true)
        let thirdCharacter = state.update(hasText: true)
        #expect(secondCharacter == .unchanged)
        #expect(thirdCharacter == .unchanged)

        let cleared = state.update(hasText: false)
        #expect(cleared == .stopped)
        #expect(!state.isAdvertised)
        let stillEmpty = state.update(hasText: false)
        #expect(stillEmpty == .unchanged)
    }

    @Test
    func codexTypingPresenceIdleStopIsIdempotent() {
        var state = CodexTypingPresenceState()
        let started = state.update(hasText: true)
        #expect(started == .started)
        let firstStop = state.stop()
        let secondStop = state.stop()
        #expect(firstStop)
        #expect(!secondStop)
        #expect(!state.isAdvertised)
    }

    @Test
    func codexComposerAcceptsMultilineAndQuickPathStyleDraftsButNotWhitespace() {
        #expect(fleetChatDraftContainsSendableText("first line\nsecond line"))
        #expect(fleetChatDraftContainsSendableText("Let’s review the workspace"))
        #expect(!fleetChatDraftContainsSendableText("  \n\t"))
    }

    @Test
    func failedCodexSendRestoresTheMessageWithoutDroppingNewTyping() {
        #expect(
            restoredFleetChatDraftAfterFailedSend(
                sent: "first line\nsecond line",
                current: "next message"
            ) == "first line\nsecond line\n\nnext message"
        )
        #expect(restoredFleetChatDraftAfterFailedSend(sent: "retry me", current: "") == "retry me")
    }

    @Test
    func codexSessionFindsAProjectFromItsDevicePathMapping() {
        #expect(
            codexProjectPathContainsSessionCWD(
                projectPath: "/Users/example/Projects/test",
                sessionCWD: "/Users/example/projects/test"
            )
        )
        #expect(
            codexProjectPathContainsSessionCWD(
                projectPath: #"D:\Projects\Fleet"#,
                sessionCWD: #"D:\Projects\Fleet\apps\desktop"#
            )
        )
        #expect(
            !codexProjectPathContainsSessionCWD(
                projectPath: "/Users/example/fleet",
                sessionCWD: "/Users/example/fleet-copy"
            )
        )
    }

    @Test
    func hostedPreviewLinksNeverOpenTheViewingDevicesLocalhost() {
        #expect(safeFleetPreviewURL("http://127.0.0.1:3000") == nil)
        #expect(safeFleetPreviewURL("http://localhost:3000") == nil)
        #expect(safeFleetPreviewURL("http://192.168.1.5:3000") == nil)
        #expect(safeFleetPreviewURL("http://example.com:3000") == nil)
        #expect(safeFleetPreviewURL("https://mini64.tailnet.ts.net:38524") != nil)
        #expect(safeFleetPreviewURL("http://100.64.0.10:3000") != nil)
        #expect(safeFleetPreviewURL("http://[fd7a:115c:a1e0::1]:3000") != nil)
    }

    @Test
    func createdCodexSessionNavigatesAfterItsSheetDismisses() {
        var state = CodexSessionNavigationState()
        state.recordCreatedSession("session-123")
        #expect(state.presentedSessionID == nil)
        #expect(state.pendingCreatedSessionID == "session-123")

        state.presentPendingSession()
        #expect(state.pendingCreatedSessionID == nil)
        #expect(state.presentedSessionID == "session-123")

        state.dismissPresentedSession()
        #expect(state.presentedSessionID == nil)
    }

    @Test
    func missionHealthUsesCoreSummaryInsteadOfOfflineDeviceCount() {
        #expect(fleetMenuHealthIsNominal(.healthy))
        #expect(!fleetMenuHealthIsNominal(.degraded))
        #expect(!fleetMenuHealthIsNominal(.critical))
    }

    @Test
    func completedCodexTurnRemainsCurrentWhileAgentOwnsTheSession() {
        let activeSessionIDs = Set(["mini64-session"])

        #expect(
            codexSessionIsCurrent(
                sessionID: "mini64-session",
                status: .completed,
                activeSessionIDs: activeSessionIDs
            )
        )
        #expect(
            !codexSessionIsCurrent(
                sessionID: "historical-session",
                status: .completed,
                activeSessionIDs: activeSessionIDs
            )
        )
        #expect(
            codexSessionIsCurrent(
                sessionID: "ready-session",
                status: .ready,
                activeSessionIDs: []
            )
        )
        #expect(
            !codexSessionIsCurrent(
                sessionID: "stopped-session",
                status: .stopped,
                activeSessionIDs: activeSessionIDs
            )
        )
    }

    @Test
    func sensitiveActionsFailClosedWhenOwnerAuthenticationIsUnavailable() {
        let message = sensitiveActionAuthenticationUnavailableMessage(nil)
        #expect(message.contains("locked"))
        #expect(message.contains("unavailable"))
    }

    @Test
    func failedConnectionAttemptKeepsThePriorRuntimeConnection() throws {
        let prior = try FleetConnection(coreURL: "https://core.example.test", token: "prior-token")
        let checkpoint = FleetConnectionRollbackCheckpoint(
            connection: prior,
            state: .connected
        )

        #expect(checkpoint.connection == prior)
        #expect(checkpoint.restoredState == .connected)
        #expect(checkpoint.shouldRestartLiveStream)
    }

    @Test
    func failedInitialConnectionReturnsToDisconnected() {
        let checkpoint = FleetConnectionRollbackCheckpoint(
            connection: nil,
            state: .connecting
        )

        #expect(checkpoint.restoredState == .disconnected)
        #expect(!checkpoint.shouldRestartLiveStream)
    }

    @Test
    func rollbackRestoresTheAPIClientCredential() async throws {
        let prior = try FleetConnection(coreURL: "https://prior.example.test", token: "prior-token")
        let candidate = try FleetConnection(coreURL: "https://candidate.example.test", token: "candidate-token")
        let client = FleetAPIClient(connection: prior)

        await client.configure(candidate)
        await restoreFleetClientConnection(prior, client: client)
        let restored = await client.currentConnection()

        #expect(restored == prior)
    }

    @Test
    func enrollmentQRCodeAcceptsJSONWithoutRegisteringASecretBearingURL() {
        let result = parseFleetEnrollmentQRCode(
            #"{"coreUrl":"https://core.example.test","token":"scoped-token"}"#
        )
        #expect(
            result == .connection(
                coreURL: "https://core.example.test",
                token: "scoped-token"
            )
        )
    }

    @Test
    func enrollmentURLNeverExtractsAQueryToken() {
        let result = parseFleetEnrollmentQRCode(
            "https://core.example.test/enroll?token=must-not-be-ingested"
        )
        #expect(result == .coreURLOnly("https://core.example.test"))
        #expect(parseFleetEnrollmentQRCode("fleetcanvas://enroll?token=secret") == .invalid)
    }
}
