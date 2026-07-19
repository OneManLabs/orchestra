import Foundation

struct FleetDeviceMentionQuery: Equatable {
    let range: Range<String.Index>
    let query: String
}

struct FleetDeviceMentionSuggestion: Identifiable, Equatable {
    let id: String
    let alias: String
    let label: String
    let detail: String
}

func fleetNormalizedDeviceAlias(_ value: String) -> String {
    String(value.lowercased().filter { $0.isLetter || $0.isNumber })
}

func fleetPreferredDeviceAlias(_ device: FleetDevice) -> String {
    if let model = device.metrics.gpus
        .flatMap({ $0.model.split(whereSeparator: { !$0.isNumber }) })
        .map(String.init)
        .first(where: { $0.count == 4 }) {
        return model
    }
    let identity = "\(device.name) \(device.hostname)".lowercased()
    if device.role == .storage, identity.contains("nas") { return "nas" }
    if identity.contains("macbook pro") || identity.contains("macbook-pro") { return "mbp" }
    if identity.contains("mac mini") || identity.contains("mac-mini") {
        let memoryGB = Int((device.metrics.memory.totalBytes / pow(1024, 3)).rounded())
        if memoryGB > 0 { return "mini\(memoryGB)" }
    }
    if device.role == .core { return "core" }
    let compact = fleetNormalizedDeviceAlias(device.name)
    return compact.isEmpty ? fleetNormalizedDeviceAlias(device.hostname) : compact
}

func fleetDeviceAliases(_ device: FleetDevice) -> Set<String> {
    var aliases = Set([
        fleetPreferredDeviceAlias(device),
        fleetNormalizedDeviceAlias(device.id),
        fleetNormalizedDeviceAlias(device.name),
        fleetNormalizedDeviceAlias(device.hostname),
        fleetNormalizedDeviceAlias(device.hostname.replacingOccurrences(of: ".local", with: "", options: .caseInsensitive)),
        fleetNormalizedDeviceAlias(device.role.rawValue),
    ])
    let initials = device.name
        .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        .compactMap(\.first)
        .map(String.init)
        .joined()
        .lowercased()
    if !initials.isEmpty { aliases.insert(initials) }
    for gpu in device.metrics.gpus {
        aliases.insert(fleetNormalizedDeviceAlias(gpu.model))
        for model in gpu.model.split(whereSeparator: { !$0.isNumber }).map(String.init) where model.count == 4 {
            aliases.insert(model)
        }
    }
    return Set(aliases.filter { !$0.isEmpty })
}

func fleetDeviceMentionQuery(in text: String) -> FleetDeviceMentionQuery? {
    let boundary = text.lastIndex(where: { $0.isWhitespace }).map { text.index(after: $0) } ?? text.startIndex
    guard boundary < text.endIndex, text[boundary] == "@" else { return nil }
    let queryStart = text.index(after: boundary)
    let query = String(text[queryStart...])
    guard query.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-" }) else { return nil }
    return FleetDeviceMentionQuery(range: boundary..<text.endIndex, query: query)
}

func fleetDeviceMentionSuggestions(devices: [FleetDevice], query: String) -> [FleetDeviceMentionSuggestion] {
    let normalizedQuery = fleetNormalizedDeviceAlias(query)
    return devices.compactMap { device in
        let aliases = fleetDeviceAliases(device)
        guard normalizedQuery.isEmpty || aliases.contains(where: { $0.hasPrefix(normalizedQuery) }) else {
            return nil
        }
        return FleetDeviceMentionSuggestion(
            id: device.id,
            alias: fleetPreferredDeviceAlias(device),
            label: device.name,
            detail: "\(device.status.displayName) · \(device.role.displayName)"
        )
    }
    .sorted { left, right in
        let leftDevice = devices.first { $0.id == left.id }
        let rightDevice = devices.first { $0.id == right.id }
        let leftOffline = leftDevice?.status == .offline
        let rightOffline = rightDevice?.status == .offline
        if leftOffline != rightOffline { return !leftOffline }
        return left.alias.localizedStandardCompare(right.alias) == .orderedAscending
    }
}

func fleetInsertDeviceMention(_ suggestion: FleetDeviceMentionSuggestion, into text: String) -> String {
    guard let active = fleetDeviceMentionQuery(in: text) else { return text }
    return text.replacingCharacters(in: active.range, with: "@\(suggestion.alias) ")
}
