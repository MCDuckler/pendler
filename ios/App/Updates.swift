import Foundation
import UIKit

/// What the box has, and whether it is newer than what is running.
///
/// iOS cannot install anything itself and the app is signed on the phone by SideStore,
/// so this notices a newer build and hands the ipa link to SideStore (AltStore, then
/// Safari as fallbacks). CI attaches the ipa to a release and the Pendler server on the
/// box re-hosts it under `<server>/app/`.
struct Release: Decodable, Equatable {
    let version: String
    let build: String
    let bytes: Int
    let built: String?
    let url: String
    let notes: String?

    /// Build stamps are UTC `YYYYMMDDHHMM`: in order by construction.
    func isNewer(than mine: String) -> Bool {
        guard let theirs = Int(build) else { return false }
        guard let ours = Int(mine) else { return true }
        return theirs > ours
    }
    var size: String { String(format: "%.1f MB", Double(bytes) / 1_048_576) }
}

enum Updates {
    static var base: String { SharedStore.pendlerURL ?? SharedStore.defaultPendlerURL }
    static var sourceURL: String { "\(base)/app/source.json" }
    static var manifestURL: String { "\(base)/app/latest.json" }

    static var running: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "" }
    static var runningVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }

    static func latest() async -> Release? {
        guard let u = URL(string: manifestURL + "?t=\(Int(Date().timeIntervalSince1970))") else { return nil }
        var r = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        r.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        guard let (d, resp) = try? await URLSession.shared.data(for: r),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(Release.self, from: d)
    }

    private static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s }

    /// Hand the ipa to whichever sideloader is installed; a scheme nothing handles simply does not open.
    @MainActor
    static func install(_ release: Release) async -> Bool {
        let targets = ["sidestore://install?url=\(enc(release.url))", "altstore://install?url=\(enc(release.url))", release.url]
        for t in targets {
            guard let u = URL(string: t) else { continue }
            if await UIApplication.shared.open(u) { return true }
        }
        return false
    }

    /// Adding the source once turns every later build into a normal SideStore update.
    @MainActor
    static func addSource() async -> Bool {
        for t in ["sidestore://source?url=\(enc(sourceURL))", "altstore://source?url=\(enc(sourceURL))", sourceURL] {
            guard let u = URL(string: t) else { continue }
            if await UIApplication.shared.open(u) { return true }
        }
        return false
    }
}
