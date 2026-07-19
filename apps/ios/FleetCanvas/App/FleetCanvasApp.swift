import SwiftUI

@main
struct FleetCanvasApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = FleetStore()

    var body: some Scene {
        WindowGroup {
            FleetRootView()
                .environment(store)
                .preferredColorScheme(.dark)
                .task { await store.start() }
                .onChange(of: scenePhase) {
                    guard scenePhase == .active else { return }
                    Task { await store.appDidBecomeActive() }
                }
        }
    }
}
