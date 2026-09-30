import Foundation

enum APIError: LocalizedError {
    case notPaired
    case badURL
    case status(Int, String)

    var errorDescription: String? {
        switch self {
        case .notPaired: return "Not paired with a Mail Coach server"
        case .badURL: return "The server URL is not valid"
        case .status(let c, let m):
            if c == 401 { return "The token was rejected (HTTP 401)" }
            return "HTTP \(c): \(m.prefix(200))"
        }
    }
}

/// The Mail Coach server. Used by the app and by the widget, so no UIKit in here.
struct API {
    let base: URL
    let token: String

    /// From what is stored in the shared store, if paired.
    static var current: API? {
        guard let s = SharedStore.baseURL, let u = URL(string: s), let t = SharedStore.token, !t.isEmpty else { return nil }
        return API(base: u, token: t)
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.timeoutIntervalForResource = 60
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    private func request(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval = 20) throws -> URLRequest {
        var s = base.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s + path) else { throw APIError.badURL }
        var r = URLRequest(url: u)
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    private func send(_ r: URLRequest) async throws -> Data {
        let (d, resp) = try await Self.session.data(for: r)
        guard let http = resp as? HTTPURLResponse else { throw APIError.status(0, "no response") }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.status(http.statusCode, String(data: d, encoding: .utf8) ?? "")
        }
        return d
    }

    private func get<T: Decodable>(_ path: String, timeout: TimeInterval = 20) async throws -> T {
        let d = try await send(try request(path, timeout: timeout))
        return try Self.decoder.decode(T.self, from: d)
    }

    private func post<T: Decodable>(_ path: String, json: [String: String]) async throws -> T {
        let body = try JSONSerialization.data(withJSONObject: json)
        let d = try await send(try request(path, method: "POST", body: body))
        return try Self.decoder.decode(T.self, from: d)
    }

    func summary() async throws -> Summary { try await get("/api/summary") }
    func widget(timeout: TimeInterval = 12) async throws -> WidgetPayload { try await get("/api/widget", timeout: timeout) }

    func items(state: String = "open", category: String? = nil) async throws -> [Item] {
        var q = "/api/items?state=\(state)"
        if let category { q += "&category=\(category)" }
        let l: ItemList = try await get(q)
        return l.items
    }

    func thread(_ id: String) async throws -> ThreadDetail { try await get("/api/threads/\(Self.escape(id))") }

    func act(_ id: String, action: String, until: Date? = nil) async throws -> Item {
        var body = ["action": action]
        if let until { body["until"] = Dates.string(until) }
        let e: ItemEnvelope = try await post("/api/threads/\(Self.escape(id))/action", json: body)
        return e.item
    }

    func refresh() async throws {
        _ = try await send(try request("/api/refresh", method: "POST", body: Data("{}".utf8)))
    }

    func digests(limit: Int = 10) async throws -> [Digest] {
        let l: DigestList = try await get("/api/digests?limit=\(limit)")
        return l.digests
    }

    private static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s
    }
}
