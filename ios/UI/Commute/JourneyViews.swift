import SwiftUI

/// One connection: departure → arrival, the rides as badges, and the legs when expanded.
struct JourneyCard: View {
    let journey: Journey
    var recommended = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: { header }
                .buttonStyle(.plain)
            if expanded {
                Divider()
                LegList(legs: journey.legs)
            }
        }
        .padding(12)
        .background(recommended ? Brand.accent.opacity(0.10) : Color(.secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            if recommended {
                RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.accent.opacity(0.5), lineWidth: 1)
            }
        }
        .opacity(journey.cancelled == true ? 0.55 : 1)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(Dates.hhmm(journey.dep)).font(.title3.weight(.semibold).monospacedDigit())
                if let d = journey.legs.first?.departureDelay, d >= 60 { DelayText(minutes: d / 60) }
                Image(systemName: "arrow.right").font(.caption).foregroundStyle(.secondary)
                Text(Dates.hhmm(journey.arr)).font(.title3.monospacedDigit())
                Spacer()
                if journey.cancelled == true {
                    Text("Fällt aus").font(.caption.weight(.bold)).foregroundStyle(Brand.late)
                } else {
                    Text(Dates.duration(journey.duration)).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 4) {
                ForEach(Array(journey.rides.enumerated()), id: \.offset) { _, leg in
                    LineBadge(line: leg.line)
                }
                if journey.changes > 0 {
                    Text("\(journey.changes)× umsteigen").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let p = journey.firstRide?.departurePlatform {
                    Text("Gl. \(p)").font(.caption.weight(.medium))
                        .foregroundStyle(journey.firstRide?.platformChanged == true ? Brand.late : .secondary)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

struct LegList: View {
    let legs: [Leg]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(legs.enumerated()), id: \.offset) { _, leg in
                if leg.isWalk {
                    Label("\(leg.distance.map { "\($0) m" } ?? "") Fußweg · \(Dates.duration(walkTime(leg)))",
                          systemImage: "figure.walk")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            LineBadge(line: leg.line, compact: true)
                            if let d = leg.direction { Text(d).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        stopRow(time: leg.dep, delay: leg.departureDelay, name: leg.origin.name, platform: leg.departurePlatform)
                        stopRow(time: leg.arr, delay: leg.arrivalDelay, name: leg.destination.name, platform: leg.arrivalPlatform)
                        ForEach(leg.remarks ?? [], id: \.self) { r in
                            Label(r, systemImage: "exclamationmark.triangle").font(.caption2).foregroundStyle(.orange)
                        }
                        if leg.cancelled == true {
                            Text("Fahrt fällt aus").font(.caption.weight(.bold)).foregroundStyle(Brand.late)
                        }
                    }
                }
            }
        }
    }

    private func walkTime(_ l: Leg) -> TimeInterval? {
        guard let d = l.dep, let a = l.arr else { return nil }
        return a.timeIntervalSince(d)
    }

    private func stopRow(time: Date?, delay: Int?, name: String, platform: String?) -> some View {
        HStack(spacing: 6) {
            Text(Dates.hhmm(time)).font(.footnote.monospacedDigit().weight(.medium)).frame(width: 42, alignment: .leading)
            if let d = delay, d >= 60 { DelayText(minutes: d / 60) }
            Text(name).font(.footnote).lineLimit(1)
            Spacer()
            if let p = platform { Text("Gl. \(p)").font(.caption2).foregroundStyle(.secondary) }
        }
    }
}

/// "Los in 12 min" — the big number on top of Heute and in the widgets' spirit.
struct LeaveCountdown: View {
    let title: String
    let leg: LegPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.85))
            if let leave = leg.leave, let j = leg.bestJourney {
                if leave > Date() {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("Los in").font(.title3.weight(.medium))
                        Text(timerInterval: Date()...leave, countsDown: true)
                            .font(.system(size: 40, weight: .bold, design: .rounded).monospacedDigit())
                    }
                } else {
                    Text("Unterwegs").font(.system(size: 34, weight: .bold, design: .rounded))
                }
                HStack(spacing: 6) {
                    Text("ab \(Dates.hhmm(leave))")
                    if let r = j.firstRide, let line = r.line {
                        Text("·")
                        Text(line.name).fontWeight(.semibold)
                        if r.delayMin > 0 { Text("+\(r.delayMin)").fontWeight(.bold) }
                        if let p = r.departurePlatform { Text("· Gl. \(p)") }
                    }
                    Text("· an \(Dates.hhmm(leg.arrive))")
                }
                .font(.subheadline)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            } else if let e = leg.error {
                Text(e).font(.subheadline)
            } else {
                Text("Keine Verbindung gefunden").font(.subheadline)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(LinearGradient(colors: [Brand.accent, Brand.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

struct LectureRow: View {
    let lecture: Lecture
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading) {
                Text(lecture.startTime).font(.subheadline.monospacedDigit().weight(.semibold))
                Text(lecture.endTime).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            .frame(width: 48, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(lecture.name).font(.subheadline).lineLimit(2)
                if let l = lecture.location, !l.isEmpty {
                    Text(l).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }
}
