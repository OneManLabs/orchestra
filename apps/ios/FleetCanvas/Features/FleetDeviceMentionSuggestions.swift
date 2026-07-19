import SwiftUI

struct FleetDeviceMentionSuggestions: View {
    let suggestions: [FleetDeviceMentionSuggestion]
    let selectedIndex: Int
    let select: (FleetDeviceMentionSuggestion) -> Void

    var body: some View {
        if !suggestions.isEmpty {
            VStack(spacing: 0) {
                HStack(spacing: 7) {
                    Image(systemName: "at")
                        .foregroundStyle(MobileFleetPalette.cyanBright)
                    Text("Target a fleet device")
                        .font(.caption2.weight(.bold))
                    Spacer()
                    Text("Tap to insert")
                        .font(.caption2)
                        .foregroundStyle(MobileFleetPalette.mutedText)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)

                Divider().overlay(MobileFleetPalette.softBorder)

                ForEach(Array(suggestions.prefix(6).enumerated()), id: \.element.id) { index, suggestion in
                    Button {
                        select(suggestion)
                    } label: {
                        HStack(spacing: 9) {
                            Image(systemName: "server.rack")
                                .font(.caption)
                                .foregroundStyle(MobileFleetPalette.cyanBright)
                                .frame(width: 26, height: 26)
                                .background(MobileFleetPalette.cyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                            VStack(alignment: .leading, spacing: 2) {
                                Text("@\(suggestion.alias)")
                                    .font(.caption.monospaced().weight(.bold))
                                Text("\(suggestion.label) · \(suggestion.detail)")
                                    .font(.caption2)
                                    .foregroundStyle(MobileFleetPalette.mutedText)
                                    .lineLimit(1)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(index == selectedIndex ? MobileFleetPalette.cyan.opacity(0.1) : .clear)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(MobileFleetPalette.cyan.opacity(0.35), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
        }
    }
}
