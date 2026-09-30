import Foundation

/// Settings and the last widget payload, in the app group both targets share.
///
/// The group has to be found at runtime: SideStore (and AltStore) re-sign with a free
/// Apple ID by renaming `group.dance.duckduck.mailcoach` to something with the team ID
/// appended, and the code only knows the original name. So try, in order:
///   1. the configured id,
///   2. the ids SideStore records under `ALTAppGroups` in Info.plist (this bundle, and —
///      from the widget — the containing app's),
///   3. the application-groups entitlement in embedded.mobileprovision (same two bundles),
/// and use the first one iOS actually hands a container for.
enum SharedStore {
    static let configuredGroup = "group.dance.duckduck.mailcoach"
    static let defaultBaseURL = "https://89-58-49-140.nip.io/mail"

    static let resolvedGroup: String? = resolveGroup()

    /// The group's defaults, or the target's own when there is no group (the app still
    /// works; the widget then shows "open to pair").
    static var defaults: UserDefaults {
        if let g = resolvedGroup, let d = UserDefaults(suiteName: g) { return d }
        return .standard
    }

    private enum Key {
        static let baseURL = "baseURL"
        static let token = "token"
        static let payload = "widgetPayload"
        static let payloadAt = "widgetPayloadAt"
    }

    static var baseURL: String? {
        get { defaults.string(forKey: Key.baseURL) }
        set { defaults.set(newValue, forKey: Key.baseURL) }
    }

    static var token: String? {
        get { defaults.string(forKey: Key.token) }
        set { defaults.set(newValue, forKey: Key.token) }
    }

    static var isPaired: Bool { !(token ?? "").isEmpty && !(baseURL ?? "").isEmpty }

    static var payload: WidgetPayload? {
        get {
            guard let d = defaults.data(forKey: Key.payload) else { return nil }
            return try? API.decoder.decode(WidgetPayload.self, from: d)
        }
        set {
            if let newValue, let d = try? API.encoder.encode(newValue) {
                defaults.set(d, forKey: Key.payload)
                defaults.set(Date(), forKey: Key.payloadAt)
            } else {
                defaults.removeObject(forKey: Key.payload)
            }
        }
    }

    static var payloadAt: Date? { defaults.object(forKey: Key.payloadAt) as? Date }

    // MARK: - Finding the group

    private static func resolveGroup() -> String? {
        var candidates = [configuredGroup]
        for bundleURL in bundleURLs() {
            candidates += altAppGroups(at: bundleURL)
            candidates += provisionedGroups(at: bundleURL)
        }
        var seen = Set<String>()
        let ordered = candidates.filter { seen.insert($0).inserted }
        // Prefer ours when a profile lists several groups.
        let preferred = ordered.filter { $0.contains("mailcoach") } + ordered.filter { !$0.contains("mailcoach") }
        for g in preferred where FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: g) != nil {
            return g
        }
        return nil
    }

    /// This bundle, plus the containing app when running as an extension
    /// (`MailCoach.app/PlugIns/MailCoachWidgets.appex` → `MailCoach.app`).
    private static func bundleURLs() -> [URL] {
        let own = Bundle.main.bundleURL
        var urls = [own]
        if own.pathExtension == "appex" {
            urls.append(own.deletingLastPathComponent().deletingLastPathComponent())
        }
        return urls
    }

    private static func altAppGroups(at bundleURL: URL) -> [String] {
        let info: [String: Any]?
        if bundleURL == Bundle.main.bundleURL {
            info = Bundle.main.infoDictionary
        } else if let d = try? Data(contentsOf: bundleURL.appendingPathComponent("Info.plist")),
                  let p = try? PropertyListSerialization.propertyList(from: d, options: [], format: nil) as? [String: Any] {
            info = p
        } else {
            info = Bundle(url: bundleURL)?.infoDictionary
        }
        return info?["ALTAppGroups"] as? [String] ?? []
    }

    /// The profile is CMS-signed; the plist inside is plain text between `<?xml` and `</plist>`.
    private static func provisionedGroups(at bundleURL: URL) -> [String] {
        guard let data = try? Data(contentsOf: bundleURL.appendingPathComponent("embedded.mobileprovision")),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex)
        else { return [] }
        let slice = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: slice, options: [], format: nil) as? [String: Any],
              let ent = plist["Entitlements"] as? [String: Any]
        else { return [] }
        return ent["com.apple.security.application-groups"] as? [String] ?? []
    }
}
