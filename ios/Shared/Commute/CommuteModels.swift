import Foundation

// The Pendler server speaks the PWA's camelCase JSON (see docs/API.md); these mirror it.

/// A stop (has an EFA `id`) or an address/POI (coordinates only).
struct Place: Codable, Hashable {
    var type: String            // "stop" | "location"
    var id: String?
    var name: String
    var address: String?
    var latitude: Double?
    var longitude: Double?
    var products: [String: Bool]?
    var kind: String?

    var isStop: Bool { type == "stop" && id != nil }
    var stableID: String { id ?? "\(latitude ?? 0),\(longitude ?? 0)" }
    var shortName: String {
        // "Pforzheim, Hauptbahnhof" → "Hauptbahnhof"
        if let r = name.range(of: ", ") { return String(name[r.upperBound...]) }
        return name
    }
}

struct DayConf: Codable, Hashable {
    var enabled: Bool
    var outboundTime: String
    var returnTime: String
}

/// The PWA's config object, which is also what `/api/today` takes as the profile.
struct Profile: Codable, Equatable {
    var homeLocation: Place?
    var workLocation: Place?
    var outboundMode: String = "arrival"
    var returnMode: String = "departure"
    var results: Int = 4
    var viaStops: [Place] = []
    var excludedProducts: [String] = []
    var scheduleMode: String = "timetable"     // "timetable" | "manual"
    var timetableUrl: String?
    var timetableLeadMin: Int = 15
    var universityId: String?
    var university: String?
    var source: String?                        // "lsf" | "ics"
    var icsUrl: String?
    var courseId: Int?
    var coursePu: Int?
    var course: String?
    var semester: Int?
    var onboarded: Bool = false
    var days: [String: DayConf] = Profile.defaultDays

    static let defaultDays: [String: DayConf] = {
        var d: [String: DayConf] = [:]
        for i in 0...6 {
            let weekday = (1...5).contains(i)
            d[String(i)] = DayConf(enabled: weekday, outboundTime: weekday ? "08:00" : "09:00", returnTime: weekday ? "17:00" : "14:00")
        }
        return d
    }()

    var isComplete: Bool {
        homeLocation != nil && workLocation != nil && (scheduleMode == "manual" || !(timetableUrl ?? "").isEmpty)
    }
}

struct Line: Codable, Hashable {
    let name: String
    let product: String?
}

struct Leg: Codable, Hashable {
    struct Point: Codable, Hashable { let name: String; let id: String? }
    let origin: Point
    let destination: Point
    let plannedDeparture: String?
    let departure: String?
    let plannedArrival: String?
    let arrival: String?
    let departureDelay: Int?
    let arrivalDelay: Int?
    let departurePlatform: String?
    let arrivalPlatform: String?
    let platformChanged: Bool?
    let line: Line?
    let direction: String?
    let walking: Bool?
    let transfer: Bool?
    let distance: Int?
    let realtime: Bool?
    let cancelled: Bool?
    let remarks: [String]?

    var dep: Date? { departure.flatMap(Dates.parse) }
    var arr: Date? { arrival.flatMap(Dates.parse) }
    var plannedDep: Date? { plannedDeparture.flatMap(Dates.parse) }
    var isWalk: Bool { walking == true }
    var delayMin: Int { Int(((departureDelay ?? 0) + 30) / 60) }
}

struct Journey: Codable, Hashable {
    let legs: [Leg]
    let cancelled: Bool?

    var dep: Date? { legs.first?.dep }
    var arr: Date? { legs.last?.arr }
    var rides: [Leg] { legs.filter { $0.line != nil } }
    var firstRide: Leg? { rides.first ?? legs.first }
    var changes: Int { max(0, rides.count - 1) }
    var duration: TimeInterval? { if let d = dep, let a = arr { return a.timeIntervalSince(d) } else { return nil } }
    var maxDelayMin: Int { legs.map(\.delayMin).max() ?? 0 }
}

struct Lecture: Codable, Hashable {
    let name: String
    let startTime: String
    let endTime: String
    let location: String?
    let category: String?
}

struct LegPlan: Codable, Hashable {
    let target: String
    let targetAt: String?
    let mode: String
    let journeys: [Journey]
    let best: Int
    let leaveAt: String?
    let arriveAt: String?
    let delay: Int?
    let error: String?

    var bestJourney: Journey? { journeys.indices.contains(best) ? journeys[best] : nil }
    var leave: Date? { leaveAt.flatMap(Dates.parse) }
    var arrive: Date? { arriveAt.flatMap(Dates.parse) }
    /// Options from the recommended one on, for "next connection" fallbacks.
    var fromBest: [Journey] { best >= 0 ? Array(journeys[best...]) : journeys }
}

struct DayPlan: Codable, Hashable {
    let date: String
    let dow: Int
    let setup: Bool?
    let source: String?
    let lectures: [Lecture]?
    let commute: Bool
    let timetableError: String?
    let outbound: LegPlan?
    let `return`: LegPlan?

    var day: Date? { Dates.day(date) }
}

struct TodayResponse: Codable, Hashable {
    let generatedAt: String
    let today: DayPlan
    let next: DayPlan?
}

struct TimetableWeek: Codable {
    let week: String
    let days: [String: [Lecture]]
}

struct University: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let system: String           // lsf | starplan | ics
    let host: String?
    let path: String?
    let base: String?
    let pu: Int?
    let catalog: String?
}

struct Course: Codable, Hashable, Identifiable {
    let id: Int
    let a: String?
    let n: String
    let pu: Int?
}

extension University {
    /// Same URL the PWA builds (web/app.js rebuildTimetableUrl).
    func timetableURL(courseId: Int, semester: Int, coursePu: Int?) -> String? {
        switch system {
        case "lsf":
            guard let host, let path else { return nil }
            return "https://\(host)\(path)/rds?state=wplan&act=stg&pool=stg&show=plan&P.vx=mittel"
                + "&r_zuordabstgv.semvonint=\(semester)&r_zuordabstgv.sembisint=\(semester)&k_abstgv.abstgvnr=\(courseId)"
        case "starplan":
            guard let host, let base else { return nil }
            return "https://\(host)\(base)/ical?lan=de&puid=\(coursePu ?? pu ?? 0)&type=pg&pgid=\(courseId)"
        default:
            return nil
        }
    }
}

struct StopEvent: Codable, Hashable {
    struct Stop: Codable, Hashable { let id: String?; let name: String? }
    let stop: Stop?
    let plannedWhen: String?
    let when: String?
    let delay: Int?
    let platform: String?
    let line: Line
    let direction: String?
    let cancelled: Bool?
}
