import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var commute: CommuteModel
    @State private var onboarding = false

    var body: some View {
        NavigationStack {
            Form {
                CommuteSettingsSection(onboarding: $onboarding)
                RemindersSection()
                PendlerServerSection()
                MailServerSection()
                StatusSection()
                UpdateSection()
            }
            .navigationTitle("Einstellungen")
            .sheet(isPresented: $onboarding) { OnboardingView().environmentObject(commute) }
        }
    }
}

private struct CommuteSettingsSection: View {
    @EnvironmentObject var commute: CommuteModel
    @Binding var onboarding: Bool
    @State private var picking: String?

    var body: some View {
        Section {
            place("Zuhause", commute.profile.homeLocation, key: "home")
            place("Hochschule", commute.profile.workLocation, key: "work")
            if commute.profile.scheduleMode == "timetable" {
                LabeledContent("Stundenplan", value: [commute.profile.university, commute.profile.course,
                                                      commute.profile.semester.map { "\($0). Sem." }]
                    .compactMap { $0 }.joined(separator: " · "))
                Stepper("Ankunft \(commute.profile.timetableLeadMin) min vorher", value: $commute.profile.timetableLeadMin, in: 0...60, step: 5)
            } else {
                LabeledContent("Zeiten", value: "feste Zeiten")
            }
            Button("Stundenplan & Zeiten ändern") { onboarding = true }
        } header: { Text("Pendeln") }
        .sheet(item: Binding(get: { picking.map { PickKey(id: $0) } }, set: { picking = $0?.id })) { k in
            LocationSearchView(title: k.id == "home" ? "Zuhause" : "Hochschule") { p in
                if k.id == "home" { commute.profile.homeLocation = p } else { commute.profile.workLocation = p }
                Task { await commute.refresh() }
            }
            .environmentObject(commute)
        }
    }

    private func place(_ label: String, _ p: Place?, key: String) -> some View {
        Button { picking = key } label: {
            HStack {
                Text(label).foregroundStyle(.primary)
                Spacer()
                Text(p?.name ?? "Wählen").foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

private struct RemindersSection: View {
    @EnvironmentObject var commute: CommuteModel
    @State private var lead = SharedStore.leadMin

    var body: some View {
        Section {
            Stepper("Erinnern \(lead) min vor dem Losgehen", value: $lead, in: 0...30, step: 1)
                .onChange(of: lead) { _, v in
                    SharedStore.leadMin = v
                    Task {
                        if let t = commute.today { await commute.scheduleReminders(t) }
                        await commute.syncProfileToServer(force: true)
                    }
                }
        } header: { Text("Erinnerungen") } footer: {
            Text("Die Erinnerung plant das iPhone selbst. Verspätungen, Ausfälle und Gleiswechsel kommen als Push über die ntfy-App, wenn dieses iPhone mit dem Server gekoppelt ist.")
        }
    }
}

private struct PendlerServerSection: View {
    @EnvironmentObject var commute: CommuteModel
    @State private var url = SharedStore.pendlerURL ?? SharedStore.defaultPendlerURL
    @State private var token = SharedStore.pendlerToken ?? ""
    @State private var status: String?

    var body: some View {
        Section {
            TextField("Server", text: $url)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("Geräte-Token (für Pushes)", text: $token)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Speichern") {
                commute.pair(url: url, token: token)
                status = nil
                Task { await check() }
            }
            Button("Verbindung testen") { Task { await check() } }
            if let status { Text(status).font(.footnote).foregroundStyle(.secondary) }
        } header: { Text("Pendler-Server") } footer: {
            Text("Ein pendler://pair-Link (auf dem Server: `pendler pair`) füllt das aus. Ohne Token funktioniert alles außer den Server-Pushes.")
        }
        .onAppear {
            url = SharedStore.pendlerURL ?? SharedStore.defaultPendlerURL
            token = SharedStore.pendlerToken ?? ""
        }
    }

    private func check() async {
        do {
            if !(SharedStore.pendlerToken ?? "").isEmpty {
                let d = try await commute.api.device()
                status = "Gekoppelt als „\(d.name)“ · Profil \(d.hasProfile ? "auf dem Server" : "fehlt noch")"
            } else {
                _ = try await commute.api.locations("Hbf")
                status = "Server erreichbar (nicht gekoppelt)"
            }
        } catch {
            status = error.localizedDescription
        }
    }
}

private struct MailServerSection: View {
    @EnvironmentObject var model: AppModel
    @State private var url = SharedStore.baseURL ?? SharedStore.defaultBaseURL
    @State private var token = SharedStore.token ?? ""
    @State private var testing = false
    @State private var testResult: String?

    var body: some View {
        Section {
            TextField("Server URL", text: $url)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("Token", text: $token)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Speichern") {
                model.pair(url: url, token: token)
                testResult = nil
            }
            .disabled(url.isEmpty || token.isEmpty)
            Button {
                Task { await test() }
            } label: {
                HStack { Text("Verbindung testen"); if testing { Spacer(); ProgressView() } }
            }
            .disabled(!model.paired || testing)
            if let testResult { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
            if model.paired {
                Button("Entkoppeln", role: .destructive) { model.unpair(); token = "" }
            }
        } header: { Text("Uni-Mail (Mail Coach)") } footer: {
            Text("Ein mailcoach://pair-Link füllt das aus.")
        }
        .onAppear {
            url = SharedStore.baseURL ?? SharedStore.defaultBaseURL
            token = SharedStore.token ?? ""
        }
    }

    private func test() async {
        guard let api = API.current else { testResult = APIError.notPaired.localizedDescription; return }
        testing = true
        defer { testing = false }
        do {
            let w = try await api.widget()
            testResult = "Verbunden · \(w.open) offen"
            await model.load()
        } catch {
            testResult = error.localizedDescription
        }
    }
}

private struct StatusSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var commute: CommuteModel

    var body: some View {
        Section("Status") {
            LabeledContent("Plan geladen", value: commute.lastLoad.map(Dates.relative) ?? "—")
            if let s = model.summary?.lastSync, let d = Dates.parse(s) {
                LabeledContent("Postfach geprüft", value: Dates.relative(d))
            }
            LabeledContent("Widget-Speicher", value: SharedStore.resolvedGroup == nil ? "nicht geteilt" : "geteilt")
            if let g = SharedStore.resolvedGroup {
                Text(g).font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
        }
    }
}
