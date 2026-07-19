import Foundation
import XCTest

@MainActor
final class FleetCanvasLiveUITests: XCTestCase {
    func testMini64CodexSessionOpensItsDirectTailnetWebsite() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard
            let coreURL = environment["FLEET_TEST_CORE_URL"],
            let token = environment["FLEET_TEST_TOKEN"],
            !coreURL.isEmpty,
            !token.isEmpty
        else {
            throw XCTSkip("Set FLEET_TEST_CORE_URL and FLEET_TEST_TOKEN to run the live Fleet UI test.")
        }

        let hostedSession = try await mini64HostedSession(
            coreURL: coreURL,
            token: token
        )
        guard let hostedSession else {
            XCTFail("The live Core did not expose a running Fleet Canvas Landing preview matched to the mini64 Codex session.")
            return
        }

        var previewRequest = URLRequest(url: hostedSession.previewURL)
        previewRequest.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (previewData, previewResponse) = try await URLSession.shared.data(for: previewRequest)
        XCTAssertEqual(
            (previewResponse as? HTTPURLResponse)?.statusCode,
            200,
            "The direct-tailnet preview was not reachable before exercising the iOS open action."
        )
        XCTAssertTrue(
            String(decoding: previewData, as: UTF8.self)
                .contains("<title>Fleet Canvas — One interface. Every machine.</title>"),
            "The live preview did not return the expected Fleet Canvas Landing document."
        )

        let app = XCUIApplication()
        app.launchEnvironment["FLEET_CORE_URL"] = coreURL
        app.launchEnvironment["FLEET_TOKEN"] = token
        app.launch()

        let codexTab = app.tabBars.buttons["Codex"]
        XCTAssertTrue(codexTab.waitForExistence(timeout: 20), "Fleet tabs did not load from the live Core.")
        codexTab.tap()

        let sessionTitle = app.staticTexts[hostedSession.sessionTitle].firstMatch
        XCTAssertTrue(
            sessionTitle.waitForExistence(timeout: 8),
            "The real mini64 Codex session did not appear in the iOS session list."
        )
        sessionTitle.tap()

        let openWebsite = app.buttons["Open \(hostedSession.projectName) Website"].firstMatch
        XCTAssertTrue(
            openWebsite.waitForExistence(timeout: 8),
            "The mini64 Codex conversation did not expose its matched hosted website."
        )
        openWebsite.tap()

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(
            safari.wait(for: .runningForeground, timeout: 10),
            "Tapping the hosted website did not hand the direct-tailnet URL to Safari."
        )

        let expectedPageText = safari.staticTexts
            .matching(NSPredicate(format: "label CONTAINS[c] %@", "One interface. Every machine."))
            .firstMatch
        let expectedAddress = safari.descendants(matching: .any)
            .matching(NSPredicate(format: "value CONTAINS[c] %@", hostedSession.previewURL.host ?? "100.64.0.10"))
            .firstMatch
        XCTAssertTrue(
            expectedAddress.waitForExistence(timeout: 8)
                || expectedPageText.waitForExistence(timeout: 10),
            "Safari opened, but did not show the Fleet Canvas Landing page or its direct-tailnet address."
        )
    }

    func testCodexNavigationAndLiveSessionComposer() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard
            let coreURL = environment["FLEET_TEST_CORE_URL"],
            let token = environment["FLEET_TEST_TOKEN"],
            !coreURL.isEmpty,
            !token.isEmpty
        else {
            throw XCTSkip("Set FLEET_TEST_CORE_URL and FLEET_TEST_TOKEN to run the live Fleet UI test.")
        }

        let liveSession = try await mostRecentLiveSession(
            coreURL: coreURL,
            token: token
        )

        let app = XCUIApplication()
        app.launchEnvironment["FLEET_CORE_URL"] = coreURL
        app.launchEnvironment["FLEET_TOKEN"] = token
        app.launch()

        let codexTab = app.tabBars.buttons["Codex"]
        guard codexTab.waitForExistence(timeout: 20) else {
            XCTFail("Fleet tabs did not load from the live Core.")
            return
        }
        codexTab.tap()

        guard app.navigationBars["Codex"].waitForExistence(timeout: 8) else {
            XCTFail("The top-level Codex tab did not open the session list.")
            return
        }

        guard let liveSession else { return }

        let sessionTitle = app.staticTexts[liveSession.title].firstMatch
        guard sessionTitle.waitForExistence(timeout: 8) else {
            XCTFail("The live Codex session did not appear in the iOS session list.")
            return
        }
        sessionTitle.tap()

        let composer = app.descendants(matching: .any)
            .matching(identifier: "codex-composer")
            .firstMatch
        XCTAssertTrue(
            composer.waitForExistence(timeout: 8),
            "Opening a live Codex session did not expose the chat composer."
        )
        if let transcriptEventID = liveSession.transcriptEventID {
            XCTAssertTrue(
                app.descendants(matching: .any)
                    .matching(identifier: "codex-transcript-event-\(transcriptEventID)")
                    .firstMatch
                    .waitForExistence(timeout: 8),
                "Opening the live Codex session did not render its Fleet Core conversation history."
            )
        }
        composer.tap()
        if let existingDraft = composer.value as? String,
           !existingDraft.isEmpty,
           existingDraft != "Message Codex… Type @ for a fleet device" {
            composer.typeText(
                String(repeating: XCUIKeyboardKey.delete.rawValue, count: existingDraft.count)
            )
        }
        let returnKey = app.keyboards.keys["return"].firstMatch
        XCTAssertTrue(
            returnKey.waitForExistence(timeout: 3),
            "The Codex composer keyboard did not expose the native Return key."
        )
        let typingProbe = "Fleet typing stays responsive while live session updates arrive.\nReturn inserts a new line."
        composer.typeText(typingProbe)
        let populatedComposer = app.descendants(matching: .any)
            .matching(identifier: "codex-composer")
            .firstMatch
        XCTAssertTrue(
            populatedComposer.waitForExistence(timeout: 3),
            "The Codex composer disappeared while typing."
        )
        XCTAssertEqual(
            populatedComposer.value as? String,
            typingProbe,
            "The Codex composer dropped or stalled live keyboard input."
        )
        XCTAssertFalse(
            app.staticTexts
                .matching(NSPredicate(format: "label CONTAINS[c] %@", "Message too long"))
                .firstMatch
                .exists,
            "The live Fleet snapshot exceeded the iOS WebSocket transport limit."
        )
    }

    private func mostRecentLiveSession(
        coreURL: String,
        token: String
    ) async throws -> (title: String, transcriptEventID: String?)? {
        guard var components = URLComponents(string: coreURL) else {
            XCTFail("FLEET_TEST_CORE_URL is not a valid URL.")
            return nil
        }
        components.path = "/api/snapshot"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else {
            XCTFail("Could not construct the live Fleet snapshot URL.")
            return nil
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            XCTFail("The live Fleet snapshot request failed.")
            return nil
        }
        guard
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let sessions = object["sessions"] as? [[String: Any]]
        else {
            XCTFail("The live Fleet snapshot did not contain a sessions array.")
            return nil
        }

        let liveStatuses: Set<String> = [
            "starting",
            "ready",
            "thinking",
            "awaiting-approval",
            "completed",
        ]
        let candidates = sessions
            .filter { session in
                guard let status = session["status"] as? String else { return false }
                return liveStatuses.contains(status)
            }
            .sorted {
                ($0["updatedAt"] as? String ?? "") > ($1["updatedAt"] as? String ?? "")
            }
        let conversation = candidates.first {
            (($0["events"] as? [[String: Any]])?.isEmpty == false)
        } ?? candidates.first
        guard let conversation, let title = conversation["title"] as? String else {
            return nil
        }
        let events = conversation["events"] as? [[String: Any]] ?? []
        let transcriptEventID = events.last {
            guard let type = $0["type"] as? String else { return false }
            return type != "raw"
        }?["id"] as? String
        return (title, transcriptEventID)
    }

    private func mini64HostedSession(
        coreURL: String,
        token: String
    ) async throws -> (
        sessionTitle: String,
        projectName: String,
        previewURL: URL
    )? {
        guard var components = URLComponents(string: coreURL) else {
            XCTFail("FLEET_TEST_CORE_URL is not a valid URL.")
            return nil
        }
        components.path = "/api/snapshot"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else {
            XCTFail("Could not construct the live Fleet snapshot URL.")
            return nil
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            XCTFail("The live Fleet snapshot request failed.")
            return nil
        }
        guard
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let projects = object["projects"] as? [[String: Any]],
            let sessions = object["sessions"] as? [[String: Any]]
        else {
            XCTFail("The live Fleet snapshot did not contain projects and sessions.")
            return nil
        }

        guard
            let project = projects.first(where: { ($0["name"] as? String) == "Fleet Canvas Landing" }),
            let projectName = project["name"] as? String,
            let preview = project["preview"] as? [String: Any],
            (preview["status"] as? String) == "running",
            let previewValue = preview["url"] as? String,
            let previewURL = URL(string: previewValue),
            let deviceID = preview["deviceId"] as? String,
            let paths = project["paths"] as? [[String: Any]],
            let projectPath = paths.first(where: { ($0["deviceId"] as? String) == deviceID })?["path"] as? String
        else {
            return nil
        }

        let normalizedProjectPath = normalizedPath(projectPath)
        let session = sessions
            .filter { ($0["deviceId"] as? String) == deviceID }
            .filter {
                guard let cwd = $0["cwd"] as? String else { return false }
                let normalizedCWD = normalizedPath(cwd)
                return normalizedCWD == normalizedProjectPath
                    || normalizedCWD.hasPrefix(normalizedProjectPath + "/")
            }
            .sorted {
                ($0["updatedAt"] as? String ?? "") > ($1["updatedAt"] as? String ?? "")
            }
            .first
        guard let sessionTitle = session?["title"] as? String else { return nil }
        return (sessionTitle, projectName, previewURL)
    }

    private func normalizedPath(_ value: String) -> String {
        var normalized = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
            .lowercased()
        while normalized.count > 1, normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        return normalized
    }
}
