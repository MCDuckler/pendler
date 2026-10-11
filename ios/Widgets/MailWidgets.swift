import WidgetKit
import SwiftUI

struct MailCoachWidget: Widget {
    let kind = "MailCoach"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MailProvider()) { entry in
            MailWidgetView(entry: entry)
        }
        .configurationDisplayName("Uni-Mail")
        .description("What still needs an answer or action.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge,
                            .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Timeline

struct MailEntry: TimelineEntry {
    enum Status { case live, cached, unpaired }
    let date: Date
    let payload: WidgetPayload?
    let status: Status
}

struct MailProvider: TimelineProvider {
    func placeholder(in context: Context) -> MailEntry {
        MailEntry(date: Date(), payload: .sample, status: .live)
    }

    func getSnapshot(in context: Context, completion: @escaping (MailEntry) -> Void) {
        if context.isPreview {
            completion(MailEntry(date: Date(), payload: SharedStore.payload ?? .sample, status: .live))
        } else {
            completion(cachedEntry())
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MailEntry>) -> Void) {
        let next = Date().addingTimeInterval(20 * 60)
        guard let api = API.current else {
            completion(Timeline(entries: [MailEntry(date: Date(), payload: nil, status: .unpaired)], policy: .after(next)))
            return
        }
        Task {
            var entry: MailEntry
            do {
                let p = try await api.widget(timeout: 12)
                SharedStore.payload = p
                entry = MailEntry(date: Date(), payload: p, status: .live)
            } catch {
                entry = cachedEntry()
            }
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func cachedEntry() -> MailEntry {
        if !SharedStore.isPaired { return MailEntry(date: Date(), payload: nil, status: .unpaired) }
        return MailEntry(date: Date(), payload: SharedStore.payload, status: .cached)
    }
}

// MARK: - Views

struct MailWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MailEntry

    var body: some View {
        content
            .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
    }

    @ViewBuilder
    private var content: some View {
        if entry.status == .unpaired || entry.payload == nil {
            Unpaired(family: family)
        } else if let p = entry.payload {
            switch family {
            case .systemSmall: SmallView(p: p)
            case .systemMedium: MediumView(p: p)
            case .systemLarge: LargeView(p: p)
            case .accessoryCircular: CircularView(p: p)
            case .accessoryRectangular: RectangularView(p: p)
            case .accessoryInline: InlineView(p: p)
            default: SmallView(p: p)
            }
        }
    }
}

private struct Unpaired: View {
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("Open Pendler to pair mail")
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "envelope.badge")
            }
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Text("Uni-Mail").font(.headline)
                Text("Open the app to pair").font(.caption)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            VStack(spacing: 6) {
                Image(systemName: "envelope.badge").font(.title2).foregroundStyle(.blue)
                Text("Open Pendler to pair mail").font(.caption).multilineTextAlignment(.center)
            }
        }
    }
}

/// "3" over "to answer/do" — the number the badge shows too.
private struct Count: View {
    let p: WidgetPayload
    var size: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(p.open)")
                .font(.system(size: size, weight: .bold, design: .rounded))
                .foregroundStyle(p.open == 0 ? Color.green : Color.primary)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text(p.open == 0 ? "all clear" : "to answer/do")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }
}

private struct Breakdown: View {
    let p: WidgetPayload

    var body: some View {
        HStack(spacing: 8) {
            ForEach([ItemKind.reply, .todo, .deadline, .waiting], id: \.self) { c in
                let n = p.count(c)
                if n > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: c.symbol).font(.system(size: 9, weight: .semibold))
                        Text("\(n)").font(.caption2.weight(.semibold)).monospacedDigit()
                    }
                    .foregroundStyle(c.color)
                }
            }
        }
    }
}

private struct DeadlineLine: View {
    let item: Item

    var body: some View {
        HStack(spacing: 4) {
            if let d = item.dueDate { DueChip(date: d, compact: true) }
            Text(item.title).font(.caption2).lineLimit(1)
        }
    }
}

private struct Row: View {
    let item: Item

    var body: some View {
        Link(destination: Links.item(item.id)) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 2).fill(item.kind.color).frame(width: 3)
                VStack(alignment: .leading, spacing: 0) {
                    Text(item.title).font(.caption.weight(.semibold)).lineLimit(1)
                    Text(item.sender).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 2)
                if let d = item.dueDate { DueChip(date: d, compact: true) }
            }
            .frame(maxHeight: 30)
        }
    }
}

private struct SmallView: View {
    let p: WidgetPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "envelope.fill").foregroundStyle(.blue).font(.caption)
                Spacer()
                Breakdown(p: p)
            }
            Spacer(minLength: 0)
            Count(p: p)
            if let d = p.nextDeadline {
                DeadlineLine(item: d)
            } else if let top = p.top.first {
                Text(top.title).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(p.nextDeadline.map { Links.item($0.id) } ?? p.top.first.map { Links.item($0.id) } ?? Links.today)
    }
}

private struct MediumView: View {
    let p: WidgetPayload

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: "envelope.fill").foregroundStyle(.blue).font(.caption)
                Spacer(minLength: 0)
                Count(p: p, size: 40)
                Breakdown(p: p)
            }
            .frame(width: 92, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) {
                if p.top.isEmpty {
                    Spacer()
                    Text("Nothing needs you right now.").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                } else {
                    ForEach(p.top.prefix(3)) { Row(item: $0) }
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .widgetURL(Links.today)
    }
}

private struct LargeView: View {
    let p: WidgetPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom) {
                Count(p: p, size: 40)
                Spacer()
                Breakdown(p: p)
            }
            if let d = p.nextDeadline {
                HStack(spacing: 4) {
                    Image(systemName: ItemKind.deadline.symbol).font(.caption2).foregroundStyle(.red)
                    DeadlineLine(item: d)
                }
            }
            Divider()
            if p.top.isEmpty {
                Spacer()
                Text("Nothing needs you right now.").font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                ForEach([ItemKind.deadline, .reply, .todo], id: \.self) { c in
                    let rows = Array(p.top.prefix(6).filter { $0.kind == c })
                    if !rows.isEmpty {
                        Text(c.sectionTitle.uppercased())
                            .font(.system(size: 10, weight: .bold)).tracking(0.8)
                            .foregroundStyle(c.color)
                        ForEach(rows) { Row(item: $0) }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .widgetURL(Links.today)
    }
}

private struct CircularView: View {
    let p: WidgetPayload

    var body: some View {
        Gauge(value: Double(min(p.open, 10)), in: 0...10) {
            Image(systemName: "envelope")
        } currentValueLabel: {
            Text("\(p.open)").font(.system(.title3, design: .rounded).weight(.bold))
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .widgetURL(p.top.first.map { Links.item($0.id) } ?? Links.today)
    }
}

private struct RectangularView: View {
    let p: WidgetPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: "envelope.fill")
                Text(p.open == 0 ? "All clear" : "\(p.open) need you").font(.headline)
            }
            if let d = p.nextDeadline, let due = d.dueDate {
                Text("\(Dates.dueLabel(due)): \(d.title)").font(.caption).lineLimit(2)
            } else if let t = p.top.first {
                Text(t.title).font(.caption).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(p.nextDeadline.map { Links.item($0.id) } ?? p.top.first.map { Links.item($0.id) } ?? Links.today)
    }
}

private struct InlineView: View {
    let p: WidgetPayload

    var body: some View {
        if let d = p.nextDeadline, let due = d.dueDate {
            Text("\(p.open) to answer · \(Dates.dueLabel(due)) deadline")
        } else {
            Text(p.open == 0 ? "Mail: all clear" : "\(p.open) to answer/do")
        }
    }
}
