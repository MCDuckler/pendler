import SwiftUI

struct HeuteView: View {
    @EnvironmentObject var commute: CommuteModel
    @EnvironmentObject var mail: AppModel
    @State private var onboarding = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let e = commute.error { ErrorBanner(text: e) { commute.error = nil } }
                    if !commute.profile.isComplete {
                        setupPrompt
                    } else if let day = commute.focusDay {
                        DayContent(day: day, isNext: commute.today?.next != nil)
                    } else if commute.loading {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    }
                    if mail.paired { MailStrip() }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(title)
            .toolbar {
                if commute.loading { ProgressView() }
            }
            .refreshable { await commute.refresh() }
            .sheet(isPresented: $onboarding) { OnboardingView().environmentObject(commute) }
        }
    }

    private var title: String {
        guard let d = commute.focusDay else { return "Pendler" }
        return Dates.dayTitle(d.date)
    }

    private var setupPrompt: some View {
        VStack(spacing: 14) {
            Image(systemName: "tram.fill").font(.system(size: 44)).foregroundStyle(Brand.accent)
            Text("Wann musst du los?").font(.title2.weight(.semibold))
            Text("Wohnort, Hochschule und Stundenplan — dann rechnet Pendler mit Live-Daten aus, wann du losgehen musst.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Einrichten") { onboarding = true }
                .buttonStyle(.borderedProminent).tint(Brand.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

/// Lectures, the countdown for whichever leg is next, and both legs' connections.
struct DayContent: View {
    let day: DayPlan
    let isNext: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let te = day.timetableError {
                ErrorBanner(text: "Stundenplan: \(te)") {}
            }
            if !day.commute {
                ContentUnavailableView("Kein Pendeln", systemImage: "sofa",
                                       description: Text(day.source == "timetable" ? "Keine Vorlesungen an diesem Tag." : "Dieser Tag ist frei."))
            } else {
                if let leg = activeLeg {
                    LeaveCountdown(title: activeTitle, leg: leg.1)
                }
                if let lectures = day.lectures, !lectures.isEmpty {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(lectures, id: \.self) { LectureRow(lecture: $0) }
                        }
                        .padding(12)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    } header: { SectionTitle("Vorlesungen") }
                }
                if let o = day.outbound { LegSection(title: "Hinweg", subtitle: subtitle(o), leg: o) }
                if let r = day.return { LegSection(title: "Rückweg", subtitle: subtitle(r), leg: r) }
            }
        }
    }

    /// Before the outbound departure: the outbound; after it: the return.
    private var activeLeg: (String, LegPlan)? {
        if let o = day.outbound, let leave = o.leave, leave.addingTimeInterval(120) > Date() { return ("out", o) }
        if let r = day.return { return ("ret", r) }
        return day.outbound.map { ("out", $0) }
    }
    private var activeTitle: String {
        let base = activeLeg?.0 == "ret" ? "Rückweg" : "Hinweg"
        return isNext ? "\(Dates.dayTitle(day.date)) · \(base)" : base
    }

    private func subtitle(_ l: LegPlan) -> String {
        l.mode == "arrival" ? "an bis \(l.target)" : "ab \(l.target)"
    }
}

struct LegSection: View {
    let title: String
    let subtitle: String
    let leg: LegPlan
    @State private var showAll = false

    /// Collapsed: the recommended connection with one before and one after it.
    private var shownIndices: [Int] {
        let all = Array(leg.journeys.indices)
        if showAll || all.count <= 3 { return all }
        let center = max(leg.best, 0)
        let start = min(max(center - 1, 0), all.count - 3)
        return Array(start..<(start + 3))
    }

    var body: some View {
        Section {
            if let e = leg.error, leg.journeys.isEmpty {
                ErrorBanner(text: e) {}
            }
            ForEach(shownIndices, id: \.self) { i in
                JourneyCard(journey: leg.journeys[i], recommended: i == leg.best)
            }
            if leg.journeys.count > 3 {
                Button(showAll ? "Weniger" : "Alle \(leg.journeys.count) Verbindungen") { withAnimation { showAll.toggle() } }
                    .font(.footnote).tint(Brand.accent)
            }
        } header: {
            HStack(alignment: .firstTextBaseline) {
                SectionTitle(title)
                Text(subtitle).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.headline) }
}

struct ErrorBanner: View {
    let text: String
    let dismiss: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text).font(.footnote).lineLimit(3)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark").font(.footnote.weight(.bold)) }.foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// The mail "needs you" count as a tappable strip on Heute.
struct MailStrip: View {
    @EnvironmentObject var mail: AppModel

    var body: some View {
        Button { mail.selectedTab = RootTab.mail.rawValue } label: {
            HStack(spacing: 10) {
                Image(systemName: "envelope.badge").font(.title3).foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(mail.openCount == 0 ? "Uni-Mail: nichts offen" : "Uni-Mail: \(mail.openCount) offen")
                        .font(.subheadline.weight(.semibold))
                    if let first = mail.items.first(where: { $0.needsYou }) {
                        Text(first.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
