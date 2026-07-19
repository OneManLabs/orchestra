import SwiftUI

enum FleetTheme {
    static let background = Color(hex: 0x080B10)
    static let panel = Color(hex: 0x0D1118)
    static let panelElevated = Color(hex: 0x111720)
    static let surface = Color(hex: 0x151C26)
    static let border = Color(hex: 0x202A37)
    static let borderSoft = Color(hex: 0x18212C)

    static let textPrimary = Color(hex: 0xEDF3F8)
    static let textSecondary = Color(hex: 0xAAB7C6)
    static let textMuted = Color(hex: 0x6F7D8E)

    static let blue = Color(hex: 0x38BDF8)
    static let blueEmphasis = Color(hex: 0x0EA5E9)
    static let healthy = Color(hex: 0x34D399)
    static let warning = Color(hex: 0xFBBF24)
    static let critical = Color(hex: 0xFB7185)
    static let automation = Color(hex: 0xA78BFA)

    static let screenPadding: CGFloat = 16
    static let cardPadding: CGFloat = 16
    static let cardRadius: CGFloat = 14
    static let compactRadius: CGFloat = 10
    static let minimumTouchTarget: CGFloat = 44

    static let blueGradient = LinearGradient(
        colors: [Color(hex: 0x54CFF8), Color(hex: 0x28B5E9)],
        startPoint: .top,
        endPoint: .bottom
    )

    static let cardGradient = LinearGradient(
        colors: [panelElevated, panel],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

enum FleetTone: String, CaseIterable {
    case neutral
    case blue
    case healthy
    case warning
    case critical
    case automation

    var color: Color {
        switch self {
        case .neutral: FleetTheme.textMuted
        case .blue: FleetTheme.blue
        case .healthy: FleetTheme.healthy
        case .warning: FleetTheme.warning
        case .critical: FleetTheme.critical
        case .automation: FleetTheme.automation
        }
    }
}
