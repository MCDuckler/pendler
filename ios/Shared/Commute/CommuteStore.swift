import Foundation

/// Commute settings and the last plan, in the same app group the mail side uses —
/// the widget reads the profile from here and asks the server itself.
extension SharedStore {
    static let defaultPendlerURL = "https://pendler.89-58-49-140.nip.io"

    private enum CKey {
        static let pendlerURL = "pendlerURL"
        static let pendlerToken = "pendlerToken"
        static let profile = "commuteProfile"
        static let today = "commuteToday"
        static let todayAt = "commuteTodayAt"
        static let leadMin = "commuteLeadMin"
    }

    static var pendlerURL: String? {
        get { defaults.string(forKey: CKey.pendlerURL) }
        set { defaults.set(newValue, forKey: CKey.pendlerURL) }
    }

    /// Device token from `pendler pair` on the box — only needed for pushes.
    static var pendlerToken: String? {
        get { defaults.string(forKey: CKey.pendlerToken) }
        set { defaults.set(newValue, forKey: CKey.pendlerToken) }
    }

    static var profile: Profile? {
        get { defaults.data(forKey: CKey.profile).flatMap { try? JSONDecoder().decode(Profile.self, from: $0) } }
        set {
            if let newValue, let d = try? JSONEncoder().encode(newValue) { defaults.set(d, forKey: CKey.profile) }
            else { defaults.removeObject(forKey: CKey.profile) }
        }
    }

    static var today: TodayResponse? {
        get { defaults.data(forKey: CKey.today).flatMap { try? JSONDecoder().decode(TodayResponse.self, from: $0) } }
        set {
            if let newValue, let d = try? JSONEncoder().encode(newValue) {
                defaults.set(d, forKey: CKey.today)
                defaults.set(Date(), forKey: CKey.todayAt)
            } else {
                defaults.removeObject(forKey: CKey.today)
            }
        }
    }

    static var todayAt: Date? { defaults.object(forKey: CKey.todayAt) as? Date }

    /// Minutes before leaving for the "Los!" notification (local and push).
    static var leadMin: Int {
        get { (defaults.object(forKey: CKey.leadMin) as? Int) ?? 10 }
        set { defaults.set(newValue, forKey: CKey.leadMin) }
    }
}

extension Dates {
    private static let utcFormat: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    static func utc(_ d: Date) -> String { utcFormat.string(from: d) }

    private static let hm: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.timeZone = TimeZone(identifier: "Europe/Berlin")
        f.dateFormat = "HH:mm"
        return f
    }()
    /// 16:28, in German wall-clock time (the timetable's).
    static func hhmm(_ d: Date?) -> String { d.map { hm.string(from: $0) } ?? "–" }

    private static let ymd: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Europe/Berlin")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    static func ymdString(_ d: Date) -> String { ymd.string(from: d) }

    /// "Heute", "Morgen", "Mittwoch, 14.10."
    static func dayTitle(_ ymdStr: String) -> String {
        guard let d = ymd.date(from: ymdStr) else { return ymdStr }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        if cal.isDateInToday(d) { return "Heute" }
        if cal.isDateInTomorrow(d) { return "Morgen" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.timeZone = cal.timeZone
        f.dateFormat = "EEEE, d.M."
        return f.string(from: d)
    }

    /// "12 min", "1 h 05"
    static func duration(_ t: TimeInterval?) -> String {
        guard let t else { return "–" }
        let m = Int((t / 60).rounded())
        return m < 60 ? "\(m) min" : String(format: "%d h %02d", m / 60, m % 60)
    }
}
