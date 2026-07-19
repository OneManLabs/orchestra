import SwiftUI

struct FleetRootView: View {
    @Environment(FleetStore.self) private var store

    var body: some View {
        Group {
            if !store.isConfigured && store.connectionState == .disconnected {
                OnboardingView()
            } else {
                FleetTabView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.isConfigured)
    }
}

private struct FleetTabView: View {
    var body: some View {
        TabView {
            MissionDashboardView()
                .tabItem { Label("Mission", systemImage: "scope") }

            NavigationStack {
                FleetSystemView()
            }
            .tabItem { Label("System", systemImage: "bubble.left.and.sparkles") }

            FleetDevicesView()
                .tabItem { Label("Devices", systemImage: "server.rack") }

            NavigationStack {
                CodexSessionsView()
            }
            .tabItem { Label("Codex", systemImage: "sparkles") }

            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis") }
        }
        .tint(FleetTheme.blue)
        .toolbarBackground(FleetTheme.panel, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}

private struct MoreView: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink {
                    JobsView()
                } label: {
                    Label("Jobs", systemImage: "shippingbox")
                }
                NavigationLink {
                    AlertsApprovalsView()
                } label: {
                    Label("Alerts & approvals", systemImage: "exclamationmark.triangle")
                }
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("More")
            .fleetScreen()
        }
    }
}
