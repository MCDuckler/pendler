import WidgetKit
import SwiftUI

// "Los in 12:34" on the home and lock screen. The provider asks the server for today's
// plan with the profile from the app group (falls back to what the app cached), and lays
// entries at the switch points: after the outbound departure the widget shows the return.
// Countdowns are `Text(timerInterval:)`, so they tick without timeline reloads.

struct CommuteEntry: TimelineEntry {
    enum Status { case live, cached, setup }
    let date: Date
    let plan: TodayResponse?
    let status: Status
}

struct CommuteProvider: TimelineProvider {
    func placeholder(in context: Context) -> CommuteEntry { CommuteEntry(date: Date(), plan: nil, status: .setup) }

    func getSnapshot(in context: Context, completion: @escaping (CommuteEntry) -> Void) {
        completion(CommuteEntry(date: Date(), plan: SharedStore.today, status: SharedStore.profile?.isComplete == true ? .cached : .setup))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CommuteEntry>) -> Void) {
        guard let profile = SharedStore.profile, profile.isComplete else {
            completion(Timeline(entries: [CommuteEntry(date: Date(), plan: nil, status: .setup)], policy: .after(Date().addingTimeInterval(3600))))
            return
        }
        Task {
            var plan = SharedStore.today
            var status = CommuteEntry.Status.cached
            if let fresh = try? await PendlerAPI.current.today(profile, timeout: 12) {
                plan = fresh
                status = .live
                SharedStore.today = fresh
            }
            completion(Self.timeline(plan: plan, status: status, now: Date()))
        }
    }

    static func timeline(plan: TodayResponse?, status: CommuteEntry.Status, now: Date) -> Timeline<CommuteEntry> {
        var entries = [CommuteEntry(date: now, plan: plan, status: status)]
        let day = plan?.next ?? plan?.today
        let switches = [day?.outbound?.leave, day?.return?.leave]
            .compactMap { $0?.addingTimeInterval(120) }
            .filter { $0 > now }
            .sorted()
        for s in switches { entries.append(CommuteEntry(date: s, plan: plan, status: status)) }
        // Refresh often while something is coming up today (delays move), rarely otherwise.
        let soon = switches.first.map { $0.timeIntervalSince(now) < 3 * 3600 } ?? false
        let refresh = now.addingTimeInterval(soon ? 10 * 60 : 60 * 60)
        return Timeline(entries: entries, policy: .after(min(refresh, switches.first ?? refresh)))
    }
}

/// What a widget shows at `date`: the leg that's next, from the day in focus.
struct ActiveLeg {
    let title: String
    let leg: LegPlan
    let day: DayPlan

    init?(plan: TodayResponse?, at date: Date) {
        guard let plan else { return nil }
        let day = plan.next ?? plan.today
        guard day.commute else { return nil }
        let prefix = plan.next != nil ? Dates.dayTitle(day.date) + " · " : ""
        if let o = day.outbound, let leave = o.leave, leave.addingTimeInterval(120) > date {
            self.init(title: prefix + "Hinweg", leg: o, day: day)
        } else if let r = day.return, let leave = r.leave, leave.addingTimeInterval(120) > date {
            self.init(title: prefix + "Rückweg", leg: r, day: day)
        } else {
            return nil
        }
    }

    private init(title: String, leg: LegPlan, day: DayPlan) {
        self.title = title
        self.leg = leg
        self.day = day
    }
}

struct CommuteWidget: Widget {
    let kind = "PendlerCommute"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CommuteProvider()) { entry in
            CommuteWidgetView(entry: entry)
        }
        .configurationDisplayName("Pendler")
        .description("Wann du los musst — mit Live-Verspätungen.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge,
                            .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct CommuteWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: CommuteEntry

    var body: some View {
        content
            .widgetURL(URL(string: "pendler://today"))
            .containerBackground(for: .widget) {
                if family == .systemSmall || family == .systemMedium {
                    LinearGradient(colors: [Brand.accent, Brand.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
                } else {
                    Color(uiColor: .systemBackground)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        let active = ActiveLeg(plan: entry.plan, at: entry.date)
        switch family {
        case .accessoryCircular: CircularCommute(active: active, now: entry.date)
        case .accessoryRectangular: RectangularCommute(active: active, now: entry.date)
        case .accessoryInline: InlineCommute(active: active)
        case .systemLarge: LargeCommute(entry: entry, active: active)
        case .systemMedium: MediumCommute(entry: entry, active: active)
        default: SmallCommute(entry: entry, active: active)
        }
    }
}

// MARK: - Home screen

private struct Countdown: View {
    let leave: Date
    let now: Date
    var size: CGFloat = 30

    var body: some View {
        if leave > now {
            Text(timerInterval: now...leave, countsDown: true)
                .font(.system(size: size, weight: .bold, design: .rounded).monospacedDigit())
                .minimumScaleFactor(0.6)
        } else {
            Text("Jetzt").font(.system(size: size, weight: .bold, design: .rounded))
        }
    }
}

private struct RideLine: View {
    let journey: Journey
    var body: some View {
        HStack(spacing: 4) {
            if let r = journey.firstRide {
                LineBadge(line: r.line, compact: true)
                if r.delayMin > 0 { Text("+\(r.delayMin)").font(.caption2.weight(.bold)) }
                if let p = r.departurePlatform { Text("Gl. \(p)").font(.caption2) }
            }
        }
    }
}

private struct EmptyCommute: View {
    let entry: CommuteEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: entry.status == .setup ? "gearshape" : "sofa").font(.title3)
            Text(entry.status == .setup ? "In Pendler einrichten" : "Heute kein Weg mehr")
                .font(.footnote.weight(.semibold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SmallCommute: View {
    let entry: CommuteEntry
    let active: ActiveLeg?

    var body: some View {
        if let a = active, let leave = a.leg.leave, let j = a.leg.bestJourney {
            VStack(alignment: .leading, spacing: 2) {
                Text(a.title).font(.caption2.weight(.semibold)).opacity(0.85).lineLimit(1)
                Text("Los in").font(.caption)
                Countdown(leave: leave, now: entry.date, size: 30)
                Spacer(minLength: 2)
                Text("ab \(Dates.hhmm(leave)) · an \(Dates.hhmm(a.leg.arrive))").font(.caption2).lineLimit(1)
                RideLine(journey: j)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            EmptyCommute(entry: entry)
        }
    }
}

private struct MediumCommute: View {
    let entry: CommuteEntry
    let active: ActiveLeg?

    var body: some View {
        if let a = active {
            HStack(alignment: .top, spacing: 12) {
                SmallCommute(entry: entry, active: a)
                VStack(alignment: .leading, spacing: 6) {
                    if let first = a.day.lectures?.first, a.title.hasSuffix("Hinweg") {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(first.startTime) \(first.name)").font(.caption.weight(.semibold)).lineLimit(2)
                            if let l = first.location, !l.isEmpty { Text(l).font(.caption2).opacity(0.8).lineLimit(1) }
                        }
                    }
                    Text("Alternativen").font(.caption2.weight(.semibold)).opacity(0.8)
                    ForEach(Array(a.leg.fromBest.dropFirst().prefix(2).enumerated()), id: \.offset) { _, j in
                        HStack(spacing: 4) {
                            Text("\(Dates.hhmm(j.dep))→\(Dates.hhmm(j.arr))").font(.caption.monospacedDigit())
                            RideLine(journey: j)
                        }
                    }
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            EmptyCommute(entry: entry)
        }
    }
}

private struct LargeCommute: View {
    let entry: CommuteEntry
    let active: ActiveLeg?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let a = active, let leave = a.leg.leave {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(a.title).font(.caption.weight(.semibold)).foregroundStyle(Brand.accent)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text("Los in").font(.subheadline)
                            Countdown(leave: leave, now: entry.date, size: 28).foregroundStyle(Brand.accentDeep)
                        }
                    }
                    Spacer()
                    if let j = a.leg.bestJourney { RideLine(journey: j) }
                }
                Text("ab \(Dates.hhmm(leave)) · an \(Dates.hhmm(a.leg.arrive))").font(.caption).foregroundStyle(.secondary)
                Divider()
                if let lectures = a.day.lectures, !lectures.isEmpty {
                    ForEach(lectures.prefix(3), id: \.self) { l in
                        HStack(spacing: 6) {
                            Text(l.startTime).font(.caption.monospacedDigit().weight(.semibold))
                            Text(l.name).font(.caption).lineLimit(1)
                        }
                    }
                    Divider()
                }
            } else {
                Text(entry.status == .setup ? "In Pendler einrichten" : "Heute kein Weg mehr")
                    .font(.headline)
                Divider()
            }
            MailLines()
            Spacer(minLength: 0)
        }
    }
}

/// The top "needs you" mail items, from the payload the mail widget/app cached.
private struct MailLines: View {
    var body: some View {
        if let p = SharedStore.payload {
            HStack {
                Image(systemName: "envelope").font(.caption)
                Text(p.open == 0 ? "Uni-Mail: nichts offen" : "Uni-Mail: \(p.open) offen").font(.caption.weight(.semibold))
            }
            ForEach(p.top.prefix(3)) { item in
                HStack(spacing: 6) {
                    Circle().fill(item.kind.color).frame(width: 6, height: 6)
                    Text(item.title).font(.caption).lineLimit(1)
                }
            }
        }
    }
}

// MARK: - Lock screen

private struct CircularCommute: View {
    let active: ActiveLeg?
    let now: Date

    var body: some View {
        if let a = active, let leave = a.leg.leave, leave > now {
            ProgressView(timerInterval: now...leave, countsDown: true) {
                Image(systemName: "figure.walk")
            } currentValueLabel: {
                Text(Dates.hhmm(leave)).font(.system(size: 11, weight: .semibold)).minimumScaleFactor(0.6)
            }
            .progressViewStyle(.circular)
        } else {
            Image(systemName: "tram.fill")
        }
    }
}

private struct RectangularCommute: View {
    let active: ActiveLeg?
    let now: Date

    var body: some View {
        if let a = active, let leave = a.leg.leave {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text("Los").font(.headline)
                    if leave > now { Text(timerInterval: now...leave, countsDown: true).font(.headline.monospacedDigit()) }
                }
                if let r = a.leg.bestJourney?.firstRide {
                    Text("\(r.line?.name ?? "Fußweg") \(Dates.hhmm(r.plannedDep))\(r.delayMin > 0 ? " +\(r.delayMin)" : "")\(r.departurePlatform.map { " · Gl. \($0)" } ?? "")")
                        .font(.caption).lineLimit(1)
                }
                Text("an \(Dates.hhmm(a.leg.arrive))").font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            Text("Pendler · frei").font(.caption)
        }
    }
}

private struct InlineCommute: View {
    let active: ActiveLeg?
    var body: some View {
        if let a = active, let leave = a.leg.leave {
            Text("Los \(Dates.hhmm(leave)) · \(a.leg.bestJourney?.firstRide?.line?.name ?? "")")
        } else {
            Text("Pendler")
        }
    }
}
