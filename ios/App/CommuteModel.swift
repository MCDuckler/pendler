import SwiftUI
import WidgetKit
import UserNotifications

/// The commute side of the app: profile, today's plan, local "leave now" reminders.
@MainActor
final class CommuteModel: ObservableObject {
    static let shared = CommuteModel()

    @Published var profile: Profile {
        didSet {
            guard profile != oldValue else { return }
            SharedStore.profile = profile
            profileDirty = true
        }
    }
    @Published private(set) var today: TodayResponse? = SharedStore.today
    @Published private(set) var loading = false
    @Published var error: String?
    @Published private(set) var lastLoad: Date? = SharedStore.todayAt
    @Published private(set) var universities: [University] = []

    private var profileDirty = true
    private var courseCache: [String: [Course]] = [:]

    init() {
        profile = SharedStore.profile ?? Profile()
    }

    var api: PendlerAPI { PendlerAPI.current }

    /// The day to show: today, or the next commute day once today is done.
    var focusDay: DayPlan? {
        guard let t = today else { return nil }
        if let next = t.next { return next }
        return t.today
    }

    // MARK: - Loading

    func refresh() async {
        guard profile.isComplete else { return }
        loading = true
        defer { loading = false }
        do {
            let t = try await api.today(profile)
            today = t
            lastLoad = Date()
            error = nil
            SharedStore.today = t
            WidgetCenter.shared.reloadAllTimelines()
            await scheduleReminders(t)
            await syncProfileToServer()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func day(_ date: String) async throws -> DayPlan {
        try await api.day(profile, date: date)
    }

    /// Paired with the box (`pendler pair`)? Then keep its copy of the profile
    /// current, so the push watcher plans with the same settings.
    func syncProfileToServer(force: Bool = false) async {
        guard let token = SharedStore.pendlerToken, !token.isEmpty, profile.isComplete, profileDirty || force else { return }
        do {
            try await api.uploadProfile(profile, leadMin: SharedStore.leadMin)
            profileDirty = false
        } catch {
            self.error = "Profil nicht hochgeladen: \(error.localizedDescription)"
        }
    }

    // MARK: - Onboarding data

    func loadUniversities() async {
        guard universities.isEmpty else { return }
        do { universities = try await api.universities() } catch { self.error = error.localizedDescription }
    }

    func courses(for uni: University) async -> [Course] {
        if let c = courseCache[uni.id] { return c }
        let c = (try? await api.courses(uni)) ?? []
        courseCache[uni.id] = c
        return c
    }

    // MARK: - Local reminders

    /// One notification per leg, `leadMin` before the recommended departure. Works
    /// without any push service; ntfy pushes (delays, cancellations) come on top.
    func scheduleReminders(_ t: TodayResponse) async {
        let c = UNUserNotificationCenter.current()
        let pending = await c.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("leave-") }
        c.removePendingNotificationRequests(withIdentifiers: pending)
        let settings = await c.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        let lead = TimeInterval(SharedStore.leadMin * 60)
        for day in [t.today, t.next].compactMap({ $0 }) {
            for (dir, leg) in [("Hinweg", day.outbound), ("Rückweg", day.return)] {
                guard let leg, let j = leg.bestJourney, let leave = leg.leave else { continue }
                let fire = leave.addingTimeInterval(-lead)
                guard fire > Date() else { continue }
                let content = UNMutableNotificationContent()
                content.title = "\(dir): los in \(SharedStore.leadMin) min"
                let r = j.firstRide
                let plat = r?.departurePlatform.map { " · Gl. \($0)" } ?? ""
                content.body = "\(r?.line?.name ?? "Fußweg") \(Dates.hhmm(r?.plannedDep))\(plat) · an \(Dates.hhmm(leg.arrive))"
                content.sound = .default
                content.userInfo = ["link": "pendler://today"]
                let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
                let req = UNNotificationRequest(identifier: "leave-\(day.date)-\(dir)",
                                                content: content,
                                                trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: false))
                try? await c.add(req)
            }
        }
    }

    func requestNotificationPermission() async {
        let c = UNUserNotificationCenter.current()
        if await c.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await c.requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    // MARK: - Pairing

    func pair(url: String, token: String) {
        var u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while u.hasSuffix("/") { u.removeLast() }
        SharedStore.pendlerURL = u.isEmpty ? nil : u
        SharedStore.pendlerToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        // Mail Coach lives under the same host at /mail, unless it was paired elsewhere.
        if SharedStore.baseURL == nil, !u.isEmpty { SharedStore.baseURL = u + "/mail" }
        Task { await syncProfileToServer(force: true) }
    }

    func unpair() {
        SharedStore.pendlerToken = nil
    }

    func resetProfile() {
        profile = Profile()
        today = nil
        SharedStore.today = nil
        WidgetCenter.shared.reloadAllTimelines()
    }
}
