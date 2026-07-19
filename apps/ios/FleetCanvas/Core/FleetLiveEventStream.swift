import Foundation

let fleetLiveMaximumMessageBytes = 8 * 1_024 * 1_024

public enum FleetLiveStreamUpdate: Sendable, Hashable {
    case connected
    case event(FleetLiveEvent)
    case disconnected(reason: String)
    case reconnecting(attempt: Int, delaySeconds: Int)
}

public struct FleetLiveEventStream: Sendable {
    private let connection: FleetConnection
    private let autoReconnect: Bool

    internal init(connection: FleetConnection, autoReconnect: Bool) {
        self.connection = connection
        self.autoReconnect = autoReconnect
    }

    public func events() -> AsyncThrowingStream<FleetLiveStreamUpdate, Error> {
        let coordinator = FleetWebSocketCoordinator(
            connection: connection,
            autoReconnect: autoReconnect
        )
        return AsyncThrowingStream { continuation in
            let runTask = Task {
                await coordinator.run(continuation: continuation)
            }
            continuation.onTermination = { @Sendable _ in
                runTask.cancel()
                Task { await coordinator.stop() }
            }
        }
    }
}

private actor FleetWebSocketCoordinator {
    private let connection: FleetConnection
    private let autoReconnect: Bool
    private let session: URLSession
    private let delegate: FleetOriginSessionDelegate
    private var socket: URLSessionWebSocketTask?
    private var stopped = false

    init(connection: FleetConnection, autoReconnect: Bool) {
        self.connection = connection
        self.autoReconnect = autoReconnect
        let delegate = FleetOriginSessionDelegate(origin: connection.origin)
        self.delegate = delegate
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    func run(continuation: AsyncThrowingStream<FleetLiveStreamUpdate, Error>.Continuation) async {
        var attempt = 0
        while !stopped && !Task.isCancelled {
            var request = URLRequest(url: connection.origin.webSocketURL)
            request.timeoutInterval = 30
            request.httpShouldHandleCookies = false
            request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
            let task = session.webSocketTask(with: request)
            // Orchestra's initial snapshot can exceed URLSessionWebSocketTask's
            // 1 MB default. Keep the transport limit aligned with the
            // explicit post-receive validation below.
            task.maximumMessageSize = fleetLiveMaximumMessageBytes
            socket = task
            task.resume()
            var announcedConnection = false

            do {
                while !stopped && !Task.isCancelled {
                    let message = try await task.receive()
                    let data = try messageData(message)
                    guard data.count <= fleetLiveMaximumMessageBytes else {
                        throw FleetAPIError.webSocket("Orchestra sent a live event larger than 8 MB.")
                    }
                    let event: FleetLiveEvent
                    do {
                        event = try FleetCoding.decoder.decode(FleetLiveEvent.self, from: data)
                    } catch {
                        throw FleetAPIError.decoding(decodingDescription(error))
                    }
                    if !announcedConnection {
                        announcedConnection = true
                        attempt = 0
                        continuation.yield(.connected)
                    }
                    continuation.yield(.event(event))
                }
            } catch is CancellationError {
                break
            } catch {
                task.cancel(with: .goingAway, reason: nil)
                socket = nil
                if stopped || Task.isCancelled { break }
                let reason = liveErrorDescription(error)
                continuation.yield(.disconnected(reason: reason))
                guard autoReconnect else {
                    continuation.finish(throwing: FleetAPIError.webSocket(reason))
                    session.invalidateAndCancel()
                    return
                }
                attempt += 1
                let delay = min(15, 1 << min(attempt - 1, 4))
                continuation.yield(.reconnecting(attempt: attempt, delaySeconds: delay))
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    break
                }
            }
        }

        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session.invalidateAndCancel()
        continuation.finish()
    }

    func stop() {
        stopped = true
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session.invalidateAndCancel()
    }

    private func messageData(_ message: URLSessionWebSocketTask.Message) throws -> Data {
        switch message {
        case let .data(data):
            return data
        case let .string(value):
            guard let data = value.data(using: .utf8) else {
                throw FleetAPIError.webSocket("Orchestra sent invalid UTF-8.")
            }
            return data
        @unknown default:
            throw FleetAPIError.webSocket("Orchestra sent an unsupported WebSocket message.")
        }
    }

    private func liveErrorDescription(_ error: Error) -> String {
        if let fleetError = error as? FleetAPIError {
            return fleetError.localizedDescription
        }
        return networkErrorDescription(error)
    }
}
