import SwiftUI

/// First-run setup, same steps as the PWA: Standorte → Hochschule/Studiengang → fertig.
struct OnboardingView: View {
    @EnvironmentObject var commute: CommuteModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft = Profile()
    @State private var step = 0

    var body: some View {
        NavigationStack {
            Form {
                switch step {
                case 0: PlacesStep(profile: $draft)
                default: ScheduleStep(profile: $draft)
                }
            }
            .navigationTitle(step == 0 ? "Deine Wege" : "Dein Stundenplan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if step == 0 { Button("Abbrechen") { dismiss() } } else { Button("Zurück") { step -= 1 } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if step == 0 {
                        Button("Weiter") { step = 1 }.disabled(draft.homeLocation == nil || draft.workLocation == nil)
                    } else {
                        Button("Fertig") { finish() }.disabled(!draft.isComplete)
                    }
                }
            }
        }
        .tint(Brand.accent)
        .onAppear { draft = commute.profile }
        .interactiveDismissDisabled(step > 0)
    }

    private func finish() {
        draft.onboarded = true
        commute.profile = draft
        dismiss()
        Task {
            await commute.requestNotificationPermission()
            await commute.refresh()
        }
    }
}

struct PlacesStep: View {
    @Binding var profile: Profile
    @State private var picking: String?

    var body: some View {
        Section {
            pick("Zuhause", profile.homeLocation, key: "home", icon: "house.fill")
            pick("Hochschule", profile.workLocation, key: "work", icon: "graduationcap.fill")
        } footer: {
            Text("Haltestelle oder Adresse. Pendler sucht Verbindungen mit Live-Daten (EFA-BW, deutschlandweit).")
        }
        .sheet(item: Binding(get: { picking.map { PickKey(id: $0) } }, set: { picking = $0?.id })) { k in
            LocationSearchView(title: k.id == "home" ? "Zuhause" : "Hochschule") { p in
                if k.id == "home" { profile.homeLocation = p } else { profile.workLocation = p }
            }
        }
    }

    private func pick(_ label: String, _ p: Place?, key: String, icon: String) -> some View {
        Button { picking = key } label: {
            HStack {
                Label(label, systemImage: icon).foregroundStyle(.primary)
                Spacer()
                Text(p?.name ?? "Wählen").foregroundStyle(p == nil ? .tertiary : .secondary).lineLimit(1)
            }
        }
    }
}

struct PickKey: Identifiable { let id: String }

/// Hochschule + Studiengang + Semester (LSF/StarPlan), an .ics link, or fixed times.
struct ScheduleStep: View {
    @EnvironmentObject var commute: CommuteModel
    @Binding var profile: Profile
    @State private var courses: [Course] = []
    @State private var courseQuery = ""
    @State private var pickingCourse = false

    private var uni: University? { commute.universities.first { $0.id == profile.universityId } }

    var body: some View {
        Section {
            Picker("Quelle", selection: $profile.scheduleMode) {
                Text("Stundenplan").tag("timetable")
                Text("Feste Zeiten").tag("manual")
            }
            .pickerStyle(.segmented)
        }
        if profile.scheduleMode == "timetable" {
            Section("Hochschule") {
                Picker("Hochschule", selection: Binding(get: { profile.universityId ?? "" }, set: selectUni)) {
                    Text("Wählen").tag("")
                    ForEach(commute.universities) { u in Text(u.name).tag(u.id) }
                }
                if let uni, uni.system != "ics" {
                    Button { pickingCourse = true } label: {
                        HStack {
                            Text("Studiengang").foregroundStyle(.primary)
                            Spacer()
                            Text(profile.course ?? "Wählen").foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    if uni.system == "lsf" {
                        Stepper("Semester: \(profile.semester ?? 1)", value: Binding(
                            get: { profile.semester ?? 1 },
                            set: { profile.semester = $0; rebuild() }), in: 1...12)
                    }
                } else if uni != nil {
                    TextField("iCal-Link (.ics)", text: Binding(
                        get: { profile.icsUrl ?? "" },
                        set: { profile.icsUrl = $0; profile.timetableUrl = $0.trimmingCharacters(in: .whitespaces) }))
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            Section {
                Stepper("Ankommen \(profile.timetableLeadMin) min vor der ersten Vorlesung",
                        value: $profile.timetableLeadMin, in: 0...60, step: 5)
            }
        } else {
            ManualDaysSection(profile: $profile)
        }
        Section {
        } footer: {
            if let url = profile.timetableUrl, profile.scheduleMode == "timetable", !url.isEmpty {
                Text(url).font(.caption2.monospaced()).lineLimit(2)
            }
        }
        .task { await commute.loadUniversities() ; if let uni { courses = await commute.courses(for: uni) } }
        .sheet(isPresented: $pickingCourse) { coursePicker }
    }

    private func selectUni(_ id: String) {
        profile.universityId = id.isEmpty ? nil : id
        profile.university = commute.universities.first { $0.id == id }?.name
        profile.courseId = nil
        profile.course = nil
        profile.coursePu = nil
        profile.source = uni?.system == "ics" ? "ics" : "lsf"
        profile.timetableUrl = uni?.system == "ics" ? profile.icsUrl : nil
        if profile.semester == nil { profile.semester = 1 }
        courses = []
        if let uni { Task { courses = await commute.courses(for: uni) } }
    }

    private func rebuild() {
        guard let uni, let cid = profile.courseId else { return }
        profile.timetableUrl = uni.timetableURL(courseId: cid, semester: profile.semester ?? 1, coursePu: profile.coursePu)
    }

    private var coursePicker: some View {
        NavigationStack {
            List(filteredCourses) { c in
                Button {
                    profile.courseId = c.id
                    profile.course = c.n
                    profile.coursePu = c.pu
                    rebuild()
                    pickingCourse = false
                } label: {
                    VStack(alignment: .leading) {
                        Text(c.n).foregroundStyle(.primary)
                        if let a = c.a, !a.isEmpty { Text(a).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .searchable(text: $courseQuery, placement: .navigationBarDrawer(displayMode: .always))
            .navigationTitle("Studiengang")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { pickingCourse = false } } }
            .overlay { if courses.isEmpty { ProgressView() } }
        }
    }

    private var filteredCourses: [Course] {
        let tokens = courseQuery.lowercased().split(separator: " ").map(String.init)
        guard !tokens.isEmpty else { return Array(courses.prefix(300)) }
        return courses.filter { c in
            let hay = "\(c.n) \(c.a ?? "")".lowercased()
            return tokens.allSatisfy { hay.contains($0) }
        }
    }
}

struct ManualDaysSection: View {
    @Binding var profile: Profile
    private let names = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"]

    var body: some View {
        Section {
            Picker("Hinweg", selection: $profile.outboundMode) {
                Text("Ankunft um").tag("arrival"); Text("Abfahrt um").tag("departure")
            }
            Picker("Rückweg", selection: $profile.returnMode) {
                Text("Abfahrt um").tag("departure"); Text("Ankunft um").tag("arrival")
            }
        }
        Section("Tage") {
            ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in
                let key = String(d)
                let conf = profile.days[key] ?? DayConf(enabled: false, outboundTime: "08:00", returnTime: "17:00")
                VStack(alignment: .leading) {
                    Toggle(names[d], isOn: Binding(get: { conf.enabled }, set: { profile.days[key, default: conf].enabled = $0 }))
                    if conf.enabled {
                        HStack {
                            TimeField(label: "Hin", value: Binding(get: { conf.outboundTime }, set: { profile.days[key, default: conf].outboundTime = $0 }))
                            TimeField(label: "Zurück", value: Binding(get: { conf.returnTime }, set: { profile.days[key, default: conf].returnTime = $0 }))
                        }
                    }
                }
            }
        }
    }
}

/// "HH:mm" string ↔ DatePicker.
struct TimeField: View {
    let label: String
    @Binding var value: String

    var body: some View {
        DatePicker(label, selection: Binding(get: { date }, set: { value = Self.f.string(from: $0) }), displayedComponents: .hourAndMinute)
            .environment(\.locale, Locale(identifier: "de_DE"))
            .font(.footnote)
    }

    private var date: Date { Self.f.date(from: value) ?? Date() }
    private static let f: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()
}
