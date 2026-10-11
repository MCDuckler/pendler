import SwiftUI
import WidgetKit
import UserNotifications

/// A thread id the UI should open (deep link or tap), as something `.sheet(item:)` takes.
struct OpenThread: Identifiable, Equatable { let id: String }

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var summary: Summary?
    @Published private(set) var done: [Item] = []
    @Published private(set) var loading = false
    @Published var error: String?
    @Published private(set) var paired = SharedStore.isPaired
    @Published var openThread: OpenThread?
    @Published var selectedTab = 0

    @Published private(set) var update: Release?
    @Published private(set) var checkingUpdate = false
    @Published private(set) var updateDismissed = false
    private var lastUpdateCheck: Date?

    var items: [Item] { summary?.items ?? [] }
    func items(_ c: ItemKind) -> [Item] { items.filter { $0.kind == c } }
    var openCount: Int { summary?.counts["open"] ?? 0 }
    var updateAvailable: Bool { update?.isNewer(than: Updates.running) ?? false }
    var showUpdateBanner: Bool { updateAvailable && !updateDismissed }

    // MARK: - Loading

    func load() async {
        guard let api = API.current else { paired = false; return }
        paired = true
        loading = true
        defer { loading = false }
        do {
            let s = try await api.summary()
            summary = s
            error = nil
            publish(s)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadDone() async {
        guard let api = API.current else { return }
        do { done = try await api.items(state: "done") } catch { self.error = error.localizedDescription }
    }

    /// Ask the server to sync now, give it a moment, then fetch.
    func refreshNow() async {
        guard let api = API.current else { return }
        try? await api.refresh()
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        await load()
    }

    /// Widget store, widget timelines and the icon badge — after every good fetch.
    func publish(_ s: Summary) {
        let top = Array(s.items.filter { $0.needsYou }.prefix(6))
        SharedStore.payload = WidgetPayload(generatedAt: s.generatedAt, lastSync: s.lastSync,
                                            counts: s.counts, nextDeadline: s.nextDeadline, top: top)
        WidgetCenter.shared.reloadAllTimelines()
        let n = s.counts["open"] ?? 0
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(n) }
    }

    func requestBadgePermission() async {
        let c = UNUserNotificationCenter.current()
        let settings = await c.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await c.requestAuthorization(options: [.badge])
        }
    }

    // MARK: - Actions

    func act(_ item: Item, _ action: String, until: Date? = nil) async {
        guard let api = API.current else { return }
        do {
            _ = try await api.act(item.id, action: action, until: until)
            await load()
            if action == "reopen" || !done.isEmpty { await loadDone() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Pairing and links

    func pair(url: String, token: String) {
        var u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while u.hasSuffix("/") { u.removeLast() }
        SharedStore.baseURL = u
        SharedStore.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        paired = SharedStore.isPaired
        Task { await load() }
    }

    func unpair() {
        SharedStore.token = nil
        SharedStore.payload = nil
        summary = nil
        done = []
        paired = false
        WidgetCenter.shared.reloadAllTimelines()
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) }
    }

    /// pendler://pair?url=…&token=…   (Pendler server, from `pendler pair` on the box)
    /// pendler://today, pendler://mail, pendler://mail/item/<id>
    /// mailcoach://pair?url=…&token=…, mailcoach://item/<id>   (Mail Coach server, old links)
    func handle(_ url: URL) {
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let token = q.first { $0.name == "token" }?.value ?? ""
        let parts = url.pathComponents.filter { $0 != "/" }
        switch (url.scheme, url.host) {
        case ("pendler", "pair"):
            let base = q.first { $0.name == "url" }?.value ?? SharedStore.defaultPendlerURL
            if !token.isEmpty { CommuteModel.shared.pair(url: base, token: token) }
            selectedTab = RootTab.settings.rawValue
        case ("mailcoach", "pair"):
            let base = q.first { $0.name == "url" }?.value ?? SharedStore.defaultBaseURL
            if !token.isEmpty { pair(url: base, token: token) }
            selectedTab = RootTab.mail.rawValue
        case ("pendler", "mail"), ("mailcoach", "item"), ("mailcoach", "today"):
            selectedTab = RootTab.mail.rawValue
            // pendler://mail/item/<id> → ["item", id]; mailcoach://item/<id> → [id]
            let id = url.scheme == "pendler" ? (parts.first == "item" ? parts.dropFirst().first : nil) : parts.first
            if let id, !id.isEmpty { openThread = OpenThread(id: id) }
        default:
            selectedTab = RootTab.heute.rawValue
        }
    }

    // MARK: - Updates

    func checkForUpdate(force: Bool = false) async {
        if !force, let last = lastUpdateCheck, Date().timeIntervalSince(last) < 6 * 3600 { return }
        checkingUpdate = true
        defer { checkingUpdate = false }
        lastUpdateCheck = Date()
        if let r = await Updates.latest() {
            if r != update { updateDismissed = false }
            update = r
        }
    }

    func dismissUpdate() { updateDismissed = true }
}
