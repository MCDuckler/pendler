import Foundation

/// The Pendler server (commute). Public endpoints need no token; the device token
/// only unlocks the profile the server watches for pushes. Used by app and widget.
struct PendlerAPI {
    let base: URL
    let token: String?

    static var current: PendlerAPI {
        let s = SharedStore.pendlerURL ?? SharedStore.defaultPendlerURL
        return PendlerAPI(base: URL(string: s) ?? URL(string: SharedStore.defaultPendlerURL)!, token: SharedStore.pendlerToken)
    }

    static let decoder = JSONDecoder()
    static let encoder = JSONEncoder()

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.timeoutIntervalForResource = 45
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    private func url(_ path: String, _ query: [String: String] = [:]) throws -> URL {
        var s = base.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        guard var c = URLComponents(string: s + path) else { throw APIError.badURL }
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let u = c.url else { throw APIError.badURL }
        return u
    }

    private func send<T: Decodable>(_ path: String, query: [String: String] = [:], method: String = "GET",
                                    body: Data? = nil, timeout: TimeInterval = 20) async throws -> T {
        var r = URLRequest(url: try url(path, query))
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token, !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (d, resp) = try await Self.session.data(for: r)
        guard let http = resp as? HTTPURLResponse else { throw APIError.status(0, "keine Antwort") }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: d))?["error"] ?? String(data: d, encoding: .utf8) ?? ""
            throw APIError.status(http.statusCode, msg)
        }
        return try Self.decoder.decode(T.self, from: d)
    }

    // MARK: Commute

    func today(_ profile: Profile, timeout: TimeInterval = 20) async throws -> TodayResponse {
        try await send("/api/today", method: "POST", body: try Self.encoder.encode(profile), timeout: timeout)
    }

    func day(_ profile: Profile, date: String) async throws -> DayPlan {
        try await send("/api/day", query: ["date": date], method: "POST", body: try Self.encoder.encode(profile))
    }

    func locations(_ q: String) async throws -> [Place] {
        try await send("/api/locations", query: ["query": q])
    }

    func journeys(from: Place, to: Place, at date: Date, arrival: Bool, results: Int = 5) async throws -> [Journey] {
        struct R: Decodable { let journeys: [Journey] }
        let r: R = try await send("/api/journeys", query: [
            "from": Self.param(from), "to": Self.param(to),
            arrival ? "arrival" : "departure": Dates.utc(date), "results": String(results),
        ])
        return r.journeys
    }

    func departures(stop: Place, limit: Int = 12) async throws -> [StopEvent] {
        struct R: Decodable { let departures: [StopEvent] }
        let r: R = try await send("/api/departures", query: ["stop": Self.param(stop), "limit": String(limit)])
        return r.departures
    }

    func timetable(url: String, week: String) async throws -> TimetableWeek {
        try await send("/api/timetable", query: ["url": url, "week": week])
    }

    func universities() async throws -> [University] { try await send("/unis/index.json") }
    func courses(_ uni: University) async throws -> [Course] {
        guard let c = uni.catalog else { return [] }
        return try await send("/" + c)
    }

    // MARK: Paired device

    struct DeviceInfo: Decodable { let id: String; let name: String; let hasProfile: Bool }
    func device() async throws -> DeviceInfo { try await send("/api/device") }

    func uploadProfile(_ profile: Profile, leadMin: Int) async throws {
        struct Body: Encodable { let profile: Profile; let notify: [String: Int] }
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await send("/api/device/profile", method: "PUT",
                                   body: try Self.encoder.encode(Body(profile: profile, notify: ["leadMin": leadMin])))
    }

    /// Stops by id; addresses as the JSON object (the server routes by coordinates).
    static func param(_ p: Place) -> String {
        if p.isStop, let id = p.id { return id }
        return (try? String(data: encoder.encode(p), encoding: .utf8) ?? p.name) ?? p.name
    }
}
