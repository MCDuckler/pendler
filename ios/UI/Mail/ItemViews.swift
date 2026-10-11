import SwiftUI

/// One conversation in a list.
struct ItemRow: View {
    let item: Item

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.kind.symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(item.kind.color)
                .frame(width: 22, height: 22)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.title)
                        .font(.body.weight(item.isNew == true ? .semibold : .regular))
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    UrgencyDot(urgency: item.urgency ?? 0)
                }
                HStack(spacing: 6) {
                    Text(item.sender).lineLimit(1)
                    if let d = item.lastDate {
                        Text("·")
                        Text(Dates.relative(d)).lineLimit(1)
                    }
                    if (item.messageCount ?? 1) > 1 {
                        Text("·")
                        Text("\(item.messageCount ?? 1)").monospacedDigit()
                    }
                    Spacer(minLength: 0)
                    if let due = item.dueDate { DueChip(date: due, compact: true) }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                if let s = item.summary, !s.isEmpty {
                    Text(s).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// Done on the leading edge, Snooze + Ignore trailing; tap opens the thread.
struct ActionableRow: View {
    @EnvironmentObject var model: AppModel
    let item: Item
    @Binding var snoozing: Item?

    var body: some View {
        Button { model.openThread = OpenThread(id: item.id) } label: { ItemRow(item: item) }
            .buttonStyle(.plain)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { Task { await model.act(item, "done") } } label: { Label("Done", systemImage: "checkmark") }
                    .tint(.green)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button { Task { await model.act(item, "ignore") } } label: { Label("Ignore", systemImage: "eye.slash") }
                    .tint(.gray)
                Button { snoozing = item } label: { Label("Snooze", systemImage: "moon.zzz") }
                    .tint(.indigo)
            }
            .contextMenu {
                Button { Task { await model.act(item, "done") } } label: { Label("Done", systemImage: "checkmark") }
                Button { snoozing = item } label: { Label("Snooze…", systemImage: "moon.zzz") }
                Button(role: .destructive) { Task { await model.act(item, "ignore") } } label: { Label("Ignore", systemImage: "eye.slash") }
            }
    }
}

// MARK: - Snooze

enum SnoozeTimes {
    static func at(hour: Int, daysAhead: Int) -> Date {
        let cal = Calendar.current
        let day = cal.date(byAdding: .day, value: daysAhead, to: cal.startOfDay(for: Date())) ?? Date()
        return cal.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
    }
    /// Today 19:00, or nil once that has passed.
    static var tonight: Date? {
        let t = at(hour: 19, daysAhead: 0)
        return t > Date().addingTimeInterval(15 * 60) ? t : nil
    }
    static var tomorrowMorning: Date { at(hour: 8, daysAhead: 1) }
    static var nextMonday: Date {
        let cal = Calendar.current
        let weekday = cal.component(.weekday, from: Date())   // 1 = Sunday, 2 = Monday
        var ahead = (2 - weekday + 7) % 7
        if ahead == 0 { ahead = 7 }
        return at(hour: 8, daysAhead: ahead)
    }
}

/// The snooze choices for whichever item `item` holds; nil = closed.
struct SnoozeDialog: ViewModifier {
    @EnvironmentObject var model: AppModel
    @Binding var item: Item?
    @State private var picking: Item?
    @State private var custom = SnoozeTimes.tomorrowMorning

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Snooze until…", isPresented: Binding(get: { item != nil }, set: { if !$0 { item = nil } }),
                                titleVisibility: .visible, presenting: item) { it in
                if let t = SnoozeTimes.tonight {
                    Button("Tonight 19:00") { snooze(it, t) }
                }
                Button("Tomorrow 08:00") { snooze(it, SnoozeTimes.tomorrowMorning) }
                Button("Monday 08:00") { snooze(it, SnoozeTimes.nextMonday) }
                Button("Pick a date…") {
                    custom = SnoozeTimes.tomorrowMorning
                    picking = it
                }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $picking) { it in
                NavigationStack {
                    Form {
                        DatePicker("Until", selection: $custom, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                            .datePickerStyle(.graphical)
                    }
                    .navigationTitle("Snooze")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { picking = nil } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Snooze") { snooze(it, custom); picking = nil }
                        }
                    }
                }
                .presentationDetents([.medium, .large])
            }
    }

    private func snooze(_ it: Item, _ until: Date) {
        Task { await model.act(it, "snooze", until: until) }
    }
}

extension View {
    func snoozeDialog(item: Binding<Item?>) -> some View { modifier(SnoozeDialog(item: item)) }
}

// MARK: - Digest

struct DigestCard: View {
    let digest: Digest
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: digest.kind == "evening" ? "moon.stars.fill" : "sun.max.fill")
                    .foregroundStyle(digest.kind == "evening" ? Color.indigo : Color.orange)
                Text(digest.title ?? (digest.kind == "evening" ? "Evening recap" : "Morning digest"))
                    .font(.headline)
                Spacer()
                if let c = digest.created {
                    Text(c, style: .time).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(digest.body)
                .font(.callout)
                .lineLimit(expanded ? nil : 5)
                .fixedSize(horizontal: false, vertical: true)
            if digest.body.count > 220 {
                Button(expanded ? "Less" : "More") { withAnimation { expanded.toggle() } }
                    .font(.caption.weight(.semibold))
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Screens

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @State private var snoozing: Item?

    var body: some View {
        NavigationStack {
            Group {
                if !model.paired {
                    PairPrompt()
                } else {
                    List {
                        if model.error != nil {
                            Section { ErrorStrip() }.listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                        }
                        if let d = model.summary?.digest {
                            Section { DigestCard(digest: d) }
                        }
                        ForEach([ItemKind.deadline, .reply, .todo], id: \.self) { c in
                            let rows = model.items(c)
                            if !rows.isEmpty {
                                Section {
                                    ForEach(rows) { ActionableRow(item: $0, snoozing: $snoozing) }
                                } header: {
                                    Label("\(c.sectionTitle) · \(rows.count)", systemImage: c.symbol)
                                        .foregroundStyle(c.color)
                                }
                            }
                        }
                        if model.summary != nil && model.items.filter({ $0.needsYou }).isEmpty {
                            Section {
                                ContentUnavailableView("All clear", systemImage: "checkmark.seal",
                                                       description: Text("Nothing needs an answer or action right now."))
                            }
                        }
                        if let s = model.summary?.lastSync, let d = Dates.parse(s) {
                            Section {} footer: {
                                Text("Mailbox checked \(Dates.relative(d))").frame(maxWidth: .infinity)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .refreshable { await model.refreshNow() }
                    .overlay { if model.summary == nil && model.loading { ProgressView() } }
                }
            }
            .navigationTitle("Today")
            .snoozeDialog(item: $snoozing)
        }
    }
}

/// Waiting and FYI: one flat list of a single category.
struct CategoryListView: View {
    @EnvironmentObject var model: AppModel
    let category: ItemKind
    @State private var snoozing: Item?

    var body: some View {
        NavigationStack {
            Group {
                if !model.paired {
                    PairPrompt()
                } else {
                    let rows = model.items(category)
                    List {
                        if rows.isEmpty && model.summary != nil {
                            ContentUnavailableView(category == .waiting ? "Nobody owes you a reply" : "Nothing to note",
                                                   systemImage: category.symbol)
                        }
                        ForEach(rows) { ActionableRow(item: $0, snoozing: $snoozing) }
                    }
                    .listStyle(.plain)
                    .refreshable { await model.refreshNow() }
                }
            }
            .navigationTitle(category.sectionTitle)
            .snoozeDialog(item: $snoozing)
        }
    }
}

struct DoneView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if !model.paired {
                    PairPrompt()
                } else {
                    List {
                        if model.done.isEmpty {
                            ContentUnavailableView("Nothing done yet", systemImage: "checkmark.circle")
                        }
                        ForEach(model.done) { item in
                            Button { model.openThread = OpenThread(id: item.id) } label: {
                                ItemRow(item: item).opacity(0.7)
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing) {
                                Button { Task { await model.act(item, "reopen") } } label: {
                                    Label("Reopen", systemImage: "arrow.uturn.backward")
                                }
                                .tint(.blue)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await model.loadDone() }
                }
            }
            .navigationTitle("Done")
            .task { await model.loadDone() }
        }
    }
}
