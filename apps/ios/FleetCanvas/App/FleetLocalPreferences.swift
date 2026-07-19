import Foundation
import UIKit

enum FleetLocalPreferences {
    static let showInAppNoticesKey = "fleet.notices.inApp.enabled"
    static let approvalHapticsKey = "fleet.approval.haptics"
    static let sensitivePreviewsKey = "fleet.sensitive.previews"

    static var approvalHapticsEnabled: Bool {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: approvalHapticsKey) != nil else { return true }
        return defaults.bool(forKey: approvalHapticsKey)
    }
}

@MainActor
enum FleetLocalFeedback {
    static func approvalDecision(_ decision: ApprovalDecision) {
        guard FleetLocalPreferences.approvalHapticsEnabled else { return }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(decision == .decline ? .warning : .success)
    }
}
