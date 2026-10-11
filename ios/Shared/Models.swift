import Foundation

/// One conversation that still wants something from you. See API.md.
struct Item: Codable, Identifiable, Hashable {
    let id: String
    let category: String
    let title: String
    let summary: String?
    let due: String?
    let urgency: Int?
    let from: String?
    let fromAddr: String?
    let subject: String?
    let lastAt: String?
    let messageCount: Int?
    let state: String?
    let snoozedUntil: String?
    let isNew: Bool?
    let webmailUrl: String?

    var kind: ItemKind { ItemKind(rawValue: category) ?? .fyi }
    var lastDate: Date? { lastAt.flatMap(Dates.parse) }
    var dueDate: Date? { due.flatMap(Dates.day) }
    var sender: String { from ?? fromAddr ?? "Unknown" }
    var needsYou: Bool { kind.needsYou }
}

struct Digest: Codable, Identifiable, Hashable {
    let id: Int
    let kind: String
    let createdAt: String?
    let title: String?
    let body: String

    var created: Date? { createdAt.flatMap(Dates.parse) }
}

struct Summary: Codable {
    let generatedAt: String?
    let lastSync: String?
    let counts: [String: Int]
    let nextDeadline: Item?
    let digest: Digest?
    let items: [Item]
}

/// What the widget draws. Also what the app writes into the shared store after a fetch.
struct WidgetPayload: Codable {
    let generatedAt: String?
    let lastSync: String?
    let counts: [String: Int]
    let nextDeadline: Item?
    let top: [Item]

    var open: Int { counts["open"] ?? 0 }
    func count(_ c: ItemKind) -> Int { counts[c.rawValue] ?? 0 }

    static let sample = WidgetPayload(
        generatedAt: nil, lastSync: nil,
        counts: ["open": 3, "reply": 2, "todo": 1, "deadline": 0, "waiting": 1, "fyi": 4],
        nextDeadline: nil,
        top: [
            Item(id: "s1", category: "reply", title: "Answer Prof. Keller about the thesis slot", summary: nil,
                 due: nil, urgency: 2, from: "Prof. Keller", fromAddr: nil, subject: nil, lastAt: nil,
                 messageCount: 3, state: "open", snoozedUntil: nil, isNew: true, webmailUrl: nil),
            Item(id: "s2", category: "todo", title: "Upload the lab report to Moodle", summary: nil,
                 due: nil, urgency: 1, from: "Moodle", fromAddr: nil, subject: nil, lastAt: nil,
                 messageCount: 1, state: "open", snoozedUntil: nil, isNew: false, webmailUrl: nil),
            Item(id: "s3", category: "reply", title: "Confirm the group meeting time", summary: nil,
                 due: nil, urgency: 1, from: "Lena", fromAddr: nil, subject: nil, lastAt: nil,
                 messageCount: 2, state: "open", snoozedUntil: nil, isNew: false, webmailUrl: nil),
        ])
}

struct Message: Codable, Identifiable, Hashable {
    let id: Int
    let from: String?
    let fromAddr: String?
    let to: [String]?
    let cc: [String]?
    let date: String?
    let mine: Bool
    let subject: String?
    let body: String?
    let attachments: [String]?

    var when: Date? { date.flatMap(Dates.parse) }
}

struct ThreadDetail: Codable {
    let item: Item
    let messages: [Message]
}

struct ItemList: Codable { let items: [Item] }
struct ItemEnvelope: Codable { let item: Item }
struct DigestList: Codable { let digests: [Digest] }

enum ItemKind: String, CaseIterable {
    case deadline, reply, todo, waiting, fyi

    var needsYou: Bool { self == .reply || self == .todo || self == .deadline }

    var label: String {
        switch self {
        case .deadline: return "Deadline"
        case .reply: return "Reply"
        case .todo: return "To do"
        case .waiting: return "Waiting"
        case .fyi: return "FYI"
        }
    }

    var sectionTitle: String {
        switch self {
        case .deadline: return "Deadlines"
        case .reply: return "Reply"
        case .todo: return "To do"
        case .waiting: return "Waiting on others"
        case .fyi: return "FYI"
        }
    }

    var symbol: String {
        switch self {
        case .deadline: return "calendar.badge.exclamationmark"
        case .reply: return "arrowshape.turn.up.left.fill"
        case .todo: return "checklist"
        case .waiting: return "hourglass"
        case .fyi: return "info.circle.fill"
        }
    }
}

enum Dates {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func parse(_ s: String) -> Date? { iso.date(from: s) ?? isoFrac.date(from: s) }
    static func day(_ s: String) -> Date? { dayFormat.date(from: String(s.prefix(10))) }

    /// With the local offset (`+02:00`), which is what the server expects.
    static func string(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = .current
        return f.string(from: d)
    }

    /// Whole days from today to `d` (negative = overdue).
    static func daysFromToday(_ d: Date) -> Int {
        let cal = Calendar.current
        return cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: d)).day ?? 0
    }

    /// "Overdue", "Today", "Tomorrow", "Fri", "12 Oct".
    static func dueLabel(_ d: Date) -> String {
        let n = daysFromToday(d)
        if n < 0 { return n == -1 ? "Overdue 1d" : "Overdue \(-n)d" }
        if n == 0 { return "Today" }
        if n == 1 { return "Tomorrow" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate(n < 7 ? "EEE" : "d MMM")
        return f.string(from: d)
    }

    static func relative(_ d: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: d, relativeTo: Date())
    }
}
