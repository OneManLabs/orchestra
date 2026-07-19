import SwiftUI

struct FleetCard<Content: View>: View {
    private let content: Content
    private let padding: CGFloat

    init(padding: CGFloat = FleetTheme.cardPadding, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(FleetTheme.cardGradient)
            .overlay {
                RoundedRectangle(cornerRadius: FleetTheme.cardRadius, style: .continuous)
                    .stroke(FleetTheme.borderSoft, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: FleetTheme.cardRadius, style: .continuous))
    }
}

struct FleetPill: View {
    let text: String
    var tone: FleetTone = .neutral

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tone.color)
            .padding(.horizontal, 9)
            .frame(minHeight: 24)
            .background(tone.color.opacity(0.12))
            .overlay {
                Capsule().stroke(tone.color.opacity(0.42), lineWidth: 1)
            }
            .clipShape(Capsule())
            .accessibilityLabel(text)
    }
}

struct FleetStatusDot: View {
    var tone: FleetTone
    var animated = false

    var body: some View {
        Circle()
            .fill(tone.color)
            .frame(width: 8, height: 8)
            .shadow(color: tone.color.opacity(0.7), radius: animated ? 6 : 3)
            .accessibilityHidden(true)
    }
}

struct FleetMetricBar: View {
    let value: Double
    var tone: FleetTone = .blue

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(FleetTheme.border)
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [tone.color.opacity(0.65), tone.color],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: proxy.size.width * min(max(value, 0), 1))
            }
        }
        .frame(height: 4)
        .accessibilityValue("\(Int(min(max(value, 0), 1) * 100)) percent")
    }
}

struct FleetSectionHeader: View {
    let title: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(1.4)
                    .foregroundStyle(FleetTheme.textMuted)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(FleetTheme.textMuted)
                }
            }
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(FleetTheme.blue)
            }
        }
    }
}

struct FleetEmptyState: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(FleetTheme.blue)
                .frame(width: 44, height: 44)
                .background(FleetTheme.blue.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            Text(title)
                .font(.headline)
                .foregroundStyle(FleetTheme.textPrimary)
            Text(message)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(FleetTheme.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}

struct FleetPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color(hex: 0x031019))
            .frame(maxWidth: .infinity, minHeight: FleetTheme.minimumTouchTarget)
            .background(FleetTheme.blueGradient.opacity(configuration.isPressed ? 0.78 : 1))
            .clipShape(RoundedRectangle(cornerRadius: FleetTheme.compactRadius, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct FleetSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(FleetTheme.textPrimary)
            .frame(maxWidth: .infinity, minHeight: FleetTheme.minimumTouchTarget)
            .background(configuration.isPressed ? FleetTheme.surface : FleetTheme.panelElevated)
            .overlay {
                RoundedRectangle(cornerRadius: FleetTheme.compactRadius, style: .continuous)
                    .stroke(FleetTheme.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: FleetTheme.compactRadius, style: .continuous))
    }
}

extension View {
    func fleetScreen() -> some View {
        self
            .foregroundStyle(FleetTheme.textPrimary)
            .background(FleetTheme.background.ignoresSafeArea())
            .tint(FleetTheme.blue)
    }
}

enum FleetMarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case unordered([String])
    case ordered([String])
    case quote(String)
    case code(language: String?, text: String)
    case divider
}

func fleetMarkdownBlocks(_ source: String) -> [FleetMarkdownBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var blocks: [FleetMarkdownBlock] = []
    var paragraph: [String] = []
    var index = 0

    func flushParagraph() {
        guard !paragraph.isEmpty else { return }
        blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        paragraph.removeAll()
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            flushParagraph()
            let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces).nonEmpty
            var code: [String] = []
            index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                code.append(lines[index])
                index += 1
            }
            blocks.append(.code(language: language, text: code.joined(separator: "\n")))
        } else if trimmed.isEmpty {
            flushParagraph()
        } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            flushParagraph()
            blocks.append(.divider)
        } else if let heading = fleetMarkdownHeading(trimmed) {
            flushParagraph()
            blocks.append(.heading(level: heading.level, text: heading.text))
        } else if trimmed.hasPrefix("> ") || trimmed == ">" {
            flushParagraph()
            var quote: [String] = []
            while index < lines.count {
                let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                guard candidate.hasPrefix(">") else { break }
                quote.append(String(candidate.dropFirst()).trimmingCharacters(in: .whitespaces))
                index += 1
            }
            index -= 1
            blocks.append(.quote(quote.joined(separator: "\n")))
        } else if fleetMarkdownUnorderedItem(trimmed) != nil {
            flushParagraph()
            var items: [String] = []
            while index < lines.count, let item = fleetMarkdownUnorderedItem(lines[index].trimmingCharacters(in: .whitespaces)) {
                items.append(item)
                index += 1
            }
            index -= 1
            blocks.append(.unordered(items))
        } else if fleetMarkdownOrderedItem(trimmed) != nil {
            flushParagraph()
            var items: [String] = []
            while index < lines.count, let item = fleetMarkdownOrderedItem(lines[index].trimmingCharacters(in: .whitespaces)) {
                items.append(item)
                index += 1
            }
            index -= 1
            blocks.append(.ordered(items))
        } else {
            paragraph.append(line)
        }
        index += 1
    }
    flushParagraph()
    return blocks
}

private func fleetMarkdownHeading(_ line: String) -> (level: Int, text: String)? {
    let hashes = line.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") else { return nil }
    return (hashes, String(line.dropFirst(hashes + 1)))
}

private func fleetMarkdownUnorderedItem(_ line: String) -> String? {
    guard line.count >= 2 else { return nil }
    let prefix = String(line.prefix(2))
    guard ["- ", "* ", "+ "].contains(prefix) else { return nil }
    return String(line.dropFirst(2))
}

private func fleetMarkdownOrderedItem(_ line: String) -> String? {
    guard let dot = line.firstIndex(of: "."), dot < line.endIndex else { return nil }
    let number = line[..<dot]
    let after = line.index(after: dot)
    guard !number.isEmpty, number.allSatisfy(\.isNumber), after < line.endIndex, line[after] == " " else { return nil }
    return String(line[line.index(after: after)...])
}

private func fleetInlineMarkdown(_ source: String) -> AttributedString {
    (try? AttributedString(
        markdown: source,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(source)
}

struct FleetMarkdownText: View {
    let text: String
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 9) {
            ForEach(Array(fleetMarkdownBlocks(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func blockView(_ block: FleetMarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            Text(fleetInlineMarkdown(text))
                .font(headingFont(level))
                .foregroundStyle(MobileFleetPalette.primaryText)
        case let .paragraph(text):
            Text(fleetInlineMarkdown(text))
                .font(compact ? .caption : .body)
                .foregroundStyle(MobileFleetPalette.primaryText)
        case let .unordered(items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("•").foregroundStyle(MobileFleetPalette.cyanBright)
                        Text(fleetInlineMarkdown(item)).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .font(compact ? .caption : .body)
        case let .ordered(items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(index + 1).")
                            .foregroundStyle(MobileFleetPalette.cyanBright)
                            .monospacedDigit()
                        Text(fleetInlineMarkdown(item)).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .font(compact ? .caption : .body)
        case let .quote(text):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(MobileFleetPalette.cyan).frame(width: 3)
                Text(fleetInlineMarkdown(text))
                    .font(compact ? .caption : .callout)
                    .foregroundStyle(MobileFleetPalette.secondaryText)
            }
            .padding(.vertical, 2)
        case let .code(language, text):
            VStack(alignment: .leading, spacing: 0) {
                if let language {
                    Text(language.uppercased())
                        .font(.caption2.weight(.bold).monospaced())
                        .foregroundStyle(MobileFleetPalette.mutedText)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(.caption.monospaced())
                        .foregroundStyle(MobileFleetPalette.primaryText)
                        .padding(10)
                }
            }
            .background(MobileFleetPalette.background.opacity(0.85), in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(MobileFleetPalette.border, lineWidth: 1) }
        case .divider:
            Divider().overlay(MobileFleetPalette.border)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title3.weight(.bold)
        case 2: .headline.weight(.bold)
        default: .subheadline.weight(.bold)
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
