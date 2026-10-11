import SwiftUI
import CoreLocation

/// Ad-hoc A → B, like the PWA's Navigator tab.
struct NavigatorView: View {
    @EnvironmentObject var commute: CommuteModel
    @State private var from: Place?
    @State private var to: Place?
    @State private var mode = 0           // 0 jetzt, 1 ab, 2 an
    @State private var when = Date()
    @State private var journeys: [Journey] = []
    @State private var loading = false
    @State private var error: String?
    @State private var picking: PickTarget?
    @StateObject private var locator = Locator()

    enum PickTarget: String, Identifiable { case from, to; var id: String { rawValue } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    placeRow("Von", from, target: .from)
                    placeRow("Nach", to, target: .to)
                    HStack {
                        Button { swap(&from, &to); Task { await search() } } label: {
                            Label("Tauschen", systemImage: "arrow.up.arrow.down")
                        }
                        Spacer()
                        Button { useHere() } label: {
                            Label("Von hier", systemImage: "location.fill")
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.footnote)
                    Picker("Zeit", selection: $mode) {
                        Text("Jetzt").tag(0); Text("Abfahrt").tag(1); Text("Ankunft").tag(2)
                    }
                    .pickerStyle(.segmented)
                    if mode != 0 {
                        DatePicker("Zeit", selection: $when).environment(\.locale, Locale(identifier: "de_DE"))
                    }
                    quickTargets
                }
                if let error { Section { ErrorBanner(text: error) { self.error = nil } } }
                Section {
                    ForEach(Array(journeys.enumerated()), id: \.offset) { _, j in
                        JourneyCard(journey: j).listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                    }
                } header: {
                    if !journeys.isEmpty { Text("Verbindungen") }
                }
            }
            .navigationTitle("Navigator")
            .toolbar { if loading { ProgressView() } }
            .sheet(item: $picking) { t in
                LocationSearchView(title: t == .from ? "Von" : "Nach") { p in
                    if t == .from { from = p } else { to = p }
                    Task { await search() }
                }
                .environmentObject(commute)
            }
            .onChange(of: mode) { _, _ in Task { await search() } }
            .onChange(of: when) { _, _ in Task { await search() } }
            .onChange(of: locator.place) { _, p in if let p { from = p; Task { await search() } } }
            .refreshable { await search() }
        }
    }

    private var quickTargets: some View {
        HStack {
            if let home = commute.profile.homeLocation {
                Button("Nach Hause") { to = home; Task { await search() } }
            }
            if let work = commute.profile.workLocation {
                Button("Zur Hochschule") { to = work; Task { await search() } }
            }
        }
        .buttonStyle(.bordered)
        .font(.footnote)
        .tint(Brand.accent)
    }

    private func placeRow(_ label: String, _ p: Place?, target: PickTarget) -> some View {
        Button { picking = target } label: {
            HStack {
                Text(label).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
                Text(p?.name ?? "Haltestelle oder Adresse").foregroundStyle(p == nil ? .tertiary : .primary).lineLimit(1)
                Spacer()
            }
        }
        .foregroundStyle(.primary)
    }

    private func useHere() { locator.request() }

    private func search() async {
        guard let from, let to else { return }
        loading = true
        defer { loading = false }
        do {
            journeys = try await commute.api.journeys(from: from, to: to, at: mode == 0 ? Date() : when, arrival: mode == 2)
            error = journeys.isEmpty ? "Keine Verbindung gefunden" : nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One-shot "where am I" as a coordinate place the server can route from.
@MainActor
final class Locator: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var place: Place?
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func request() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        manager.requestLocation()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let c = locations.last?.coordinate else { return }
        Task { @MainActor in
            self.place = Place(type: "location", id: nil, name: "Mein Standort", address: "Mein Standort",
                               latitude: c.latitude, longitude: c.longitude, products: nil, kind: "coord")
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

/// Search field + results from /api/locations (EFA stop finder).
struct LocationSearchView: View {
    @EnvironmentObject var commute: CommuteModel
    @Environment(\.dismiss) private var dismiss
    let title: String
    let onPick: (Place) -> Void
    @State private var query = ""
    @State private var results: [Place] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                ForEach(results, id: \.stableID) { p in
                    Button {
                        onPick(p)
                        dismiss()
                    } label: {
                        HStack {
                            Image(systemName: p.isStop ? "tram.fill" : "mappin.and.ellipse")
                                .foregroundStyle(p.isStop ? Brand.accent : .secondary)
                                .frame(width: 22)
                            Text(p.name).foregroundStyle(.primary)
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Haltestelle oder Adresse")
            .task(id: query) {
                guard query.count >= 2 else { results = []; return }
                try? await Task.sleep(nanoseconds: 300_000_000)   // debounce
                guard !Task.isCancelled else { return }
                do { results = try await commute.api.locations(query); error = nil } catch { self.error = error.localizedDescription }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } } }
        }
    }
}
