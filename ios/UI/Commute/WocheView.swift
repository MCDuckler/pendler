import SwiftUI

/// The PWA's Wochenplan: lectures (or fixed times) per weekday, a tap plans that day.
struct WocheView: View {
    @EnvironmentObject var commute: CommuteModel
    @State private var weekOffset = 0
    @State private var week: TimetableWeek?
    @State private var loading = false
    @State private var error: String?

    private var monday: Date {
        var cal = Calendar(identifier: .iso8601)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let start = cal.dateInterval(of: .weekOfYear, for: Date())?.start ?? Date()
        return cal.date(byAdding: .day, value: 7 * weekOffset, to: start) ?? start
    }

    private func date(_ i: Int) -> Date { Calendar.current.date(byAdding: .day, value: i, to: monday) ?? monday }

    var body: some View {
        NavigationStack {
            List {
                if let error { ErrorBanner(text: error) { self.error = nil } }
                ForEach(0..<7, id: \.self) { i in
                    let d = date(i)
                    let ymd = Dates.ymdString(d)
                    let dow = (i + 1) % 7
                    NavigationLink {
                        DayDetailView(date: ymd)
                    } label: {
                        DayRow(date: d, lectures: lectures(dow), manual: manual(dow), timetable: isTimetable)
                    }
                    .disabled(!commute.profile.isComplete)
                }
            }
            .navigationTitle(weekTitle)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if loading { ProgressView() }
                    Button { weekOffset -= 1 } label: { Image(systemName: "chevron.left") }
                    Button("Heute") { weekOffset = 0 }.disabled(weekOffset == 0)
                    Button { weekOffset += 1 } label: { Image(systemName: "chevron.right") }
                }
            }
            .task(id: "\(weekOffset)|\(commute.profile.timetableUrl ?? "")") { await load() }
            .refreshable { await load() }
        }
    }

    private var isTimetable: Bool { commute.profile.scheduleMode == "timetable" }
    private func lectures(_ dow: Int) -> [Lecture] { week?.days[String(dow)] ?? [] }
    private func manual(_ dow: Int) -> DayConf? { isTimetable ? nil : commute.profile.days[String(dow)] }

    private var weekTitle: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "d.M."
        return "Woche \(f.string(from: monday))–\(f.string(from: date(6)))"
    }

    private func load() async {
        guard isTimetable, let url = commute.profile.timetableUrl, !url.isEmpty else { week = nil; return }
        loading = true
        defer { loading = false }
        do {
            week = try await commute.api.timetable(url: url, week: Dates.ymdString(monday))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct DayRow: View {
    let date: Date
    let lectures: [Lecture]
    let manual: DayConf?
    let timetable: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack {
                Text(date.formatted(.dateTime.weekday(.abbreviated).locale(Locale(identifier: "de_DE"))))
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(date.formatted(.dateTime.day())).font(.title3.weight(.semibold))
                    .foregroundStyle(Calendar.current.isDateInToday(date) ? Brand.accent : .primary)
            }
            .frame(width: 40)
            VStack(alignment: .leading, spacing: 4) {
                if timetable {
                    if lectures.isEmpty {
                        Text("Frei").foregroundStyle(.secondary)
                    } else {
                        Text("\(lectures.first!.startTime)–\(lectures.last!.endTime) · \(lectures.count) Termin\(lectures.count == 1 ? "" : "e")")
                            .font(.subheadline.weight(.medium))
                        ForEach(lectures.prefix(3), id: \.self) { l in
                            Text(l.name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                } else if let m = manual, m.enabled {
                    Text("Hin \(m.outboundTime) · Zurück \(m.returnTime)").font(.subheadline)
                } else {
                    Text("Frei").foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct DayDetailView: View {
    @EnvironmentObject var commute: CommuteModel
    let date: String
    @State private var plan: DayPlan?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let error { ErrorBanner(text: error) { self.error = nil } }
                if let plan { DayContent(day: plan, isNext: false) } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                }
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(Dates.dayTitle(date))
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do { plan = try await commute.day(date); error = nil } catch { self.error = error.localizedDescription }
    }
}
