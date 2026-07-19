import AppKit
import Foundation

private let maximumResponseBytes = 2 * 1024 * 1024

@main
enum FleetCanvasMenuMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = FleetCanvasMenuApp()
        application.delegate = delegate
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
final class FleetCanvasMenuApp: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var pollInFlight = false
    private var session: URLSession!
    private var presentation = FleetStatusPresentation.disconnected

    private lazy var connectionFileURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent("Fleet Canvas", isDirectory: true)
        .appendingPathComponent("desktop-connection.json", isDirectory: false)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 5
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.autosaveName = "FleetCanvasStatus"
        if let button = statusItem.button {
            button.title = "◇"
            button.toolTip = FleetStatusPresentation.disconnected.toolTip
            button.target = self
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        apply(.disconnected)
        statusItem.isVisible = true

        poll()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.poll()
            }
        }
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        session?.invalidateAndCancel()
        if statusItem != nil {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
    }

    @objc
    private func statusItemClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else {
            toggleFleetMenuBar()
            return
        }

        if event.type == .rightMouseUp {
            makeContextMenu().popUp(
                positioning: nil,
                at: NSPoint(x: sender.bounds.minX, y: sender.bounds.minY),
                in: sender
            )
        } else {
            toggleFleetMenuBar()
        }
    }

    @objc
    private func openFleetCanvas() {
        launchFleetCanvas(arguments: [], forceNewInstance: false)
    }

    @objc
    private func quitMenuIcon() {
        NSApp.terminate(nil)
    }

    private func makeContextMenu() -> NSMenu {
        let menu = NSMenu()
        let stateItem = NSMenuItem(title: presentation.toolTip, action: nil, keyEquivalent: "")
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())

        let openItem = NSMenuItem(
            title: "Open Orchestra Canvas",
            action: #selector(openFleetCanvas),
            keyEquivalent: ""
        )
        openItem.target = self
        menu.addItem(openItem)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(
            title: "Quit Menu Icon",
            action: #selector(quitMenuIcon),
            keyEquivalent: ""
        )
        quitItem.target = self
        menu.addItem(quitItem)
        return menu
    }

    private func toggleFleetMenuBar() {
        launchFleetCanvas(arguments: ["--toggle-menubar"], forceNewInstance: true)
    }

    private func launchFleetCanvas(arguments: [String], forceNewInstance: Bool) {
        guard let applicationURL = fleetCanvasApplicationURL() else {
            apply(
                FleetStatusPresentation(
                    title: "◆ !",
                    severity: .critical,
                    toolTip: "Orchestra Canvas.app was not found"
                )
            )
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        configuration.createsNewApplicationInstance = forceNewInstance
        configuration.arguments = arguments
        NSWorkspace.shared.openApplication(
            at: applicationURL,
            configuration: configuration
        ) { [weak self] _, error in
            guard error != nil else { return }
            Task { @MainActor in
                self?.apply(
                    FleetStatusPresentation(
                        title: "◆ !",
                        severity: .critical,
                        toolTip: "Orchestra Canvas could not be opened"
                    )
                )
            }
        }
    }

    private func fleetCanvasApplicationURL() -> URL? {
        let fileManager = FileManager.default
        let candidates = [
            fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Applications", isDirectory: true)
                .appendingPathComponent("Orchestra Canvas.app", isDirectory: true),
            URL(fileURLWithPath: "/Applications/Orchestra Canvas.app", isDirectory: true),
            fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Applications", isDirectory: true)
                .appendingPathComponent("Fleet Canvas.app", isDirectory: true),
            URL(fileURLWithPath: "/Applications/Fleet Canvas.app", isDirectory: true),
        ]

        for candidate in candidates where fileManager.fileExists(atPath: candidate.path) {
            return candidate
        }
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.fleetcanvas.desktop")
    }

    private func poll() {
        guard !pollInFlight else { return }
        pollInFlight = true

        let connection: FleetDesktopConnection
        let baseURL: URL
        do {
            let data = try Data(contentsOf: connectionFileURL, options: [.mappedIfSafe])
            guard data.count <= 64 * 1024 else {
                throw FleetMenuError.invalidConnection
            }
            connection = try JSONDecoder().decode(FleetDesktopConnection.self, from: data)
            baseURL = try connection.validatedBaseURL()
        } catch {
            pollInFlight = false
            apply(.disconnected)
            return
        }

        let endpoint = baseURL.appendingPathComponent("api/v2/menu-bar")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = 4
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("FleetCanvasMenu/2", forHTTPHeaderField: "User-Agent")

        session.dataTask(with: request) { [weak self] data, response, error in
            let result: Result<FleetMenuSnapshot, Error>
            if let error {
                result = .failure(error)
            } else if let httpResponse = response as? HTTPURLResponse,
                      !(200...299).contains(httpResponse.statusCode) {
                result = .failure(FleetMenuError.requestFailed(httpResponse.statusCode))
            } else if let data, data.count > maximumResponseBytes {
                result = .failure(FleetMenuError.responseTooLarge)
            } else if let data {
                do {
                    let snapshot = try JSONDecoder().decode(FleetMenuSnapshot.self, from: data)
                    guard snapshot.core.connected else {
                        throw FleetMenuError.invalidResponse
                    }
                    result = .success(snapshot)
                } catch {
                    result = .failure(error)
                }
            } else {
                result = .failure(FleetMenuError.invalidResponse)
            }

            Task { @MainActor in
                guard let self else { return }
                self.pollInFlight = false
                switch result {
                case .success(let snapshot):
                    self.apply(.connected(snapshot))
                case .failure:
                    self.apply(.disconnected)
                }
            }
        }.resume()
    }

    private func apply(_ next: FleetStatusPresentation) {
        presentation = next
        guard let button = statusItem?.button else { return }

        let color: NSColor
        switch next.severity {
        case .critical:
            color = .systemRed
        case .warning:
            color = .systemOrange
        case .disconnected:
            color = .secondaryLabelColor
        case .healthy, .activity:
            color = .labelColor
        }

        button.attributedTitle = NSAttributedString(
            string: next.title,
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
                .foregroundColor: color,
            ]
        )
        button.toolTip = next.toolTip
        statusItem.length = NSStatusItem.variableLength
    }
}
