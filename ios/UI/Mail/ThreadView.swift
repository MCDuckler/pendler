import SwiftUI

/// A whole conversation: what the coach thinks, then the messages oldest first.
struct ThreadView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let threadID: String

    @State private var detail: ThreadDetail?
    @State private var error: String?
    @State private var snoozing: Item?

    var body: some View {
        ScrollView {
            if let d = detail {
                VStack(alignment: .leading, spacing: 14) {
                    header(d.item)
                    ForEach(d.messages) { MessageCard(message: $0) }
                }
                .padding(16)
            } else if let error {
                ContentUnavailableView("Could not load", systemImage: "exclamationmark.triangle",
                                       description: Text(error))
                    .padding(.top, 60)
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(detail?.item.subject ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            if let item = detail?.item {
                ToolbarItemGroup(placement: .bottomBar) {
                    if item.state == "open" || item.state == nil {
                        Button { act(item, "done") } label: { Label("Done", systemImage: "checkmark.circle") }
                        Spacer()
                        Button { snoozing = item } label: { Label("Snooze", systemImage: "moon.zzz") }
                        Spacer()
                        Button { act(item, "ignore") } label: { Label("Ignore", systemImage: "eye.slash") }
                    } else {
                        Button { act(item, "reopen") } label: { Label("Reopen", systemImage: "arrow.uturn.backward") }
                    }
                    Spacer()
                    Button {
                        if let s = item.webmailUrl, let u = URL(string: s) { openURL(u) }
                    } label: { Label("Webmail", systemImage: "safari") }
                    .disabled(item.webmailUrl == nil)
                }
            }
        }
        .snoozeDialog(item: $snoozing)
        .onChange(of: snoozing) { old, new in
            // The dialog closed: the snooze (if any) has gone out; show the result.
            if old != nil && new == nil { Task { try? await Task.sleep(nanoseconds: 600_000_000); await reload() } }
        }
        .task { await reload() }
    }

    @ViewBuilder
    private func header(_ item: Item) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(item.kind.label, systemImage: item.kind.symbol)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .foregroundStyle(item.kind.color)
                    .background(item.kind.color.opacity(0.14), in: Capsule())
                if let due = item.dueDate { DueChip(date: due) }
                if let st = item.state, st != "open" {
                    Text(st.capitalized).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                Spacer()
                UrgencyDot(urgency: item.urgency ?? 0)
            }
            Text(item.title).font(.title3.weight(.semibold))
            if let s = item.summary, !s.isEmpty {
                Text(s).font(.callout).foregroundStyle(.secondary)
            }
            if let until = item.snoozedUntil.flatMap(Dates.parse), item.state == "snoozed" {
                Label("Snoozed until \(until.formatted(date: .abbreviated, time: .shortened))", systemImage: "moon.zzz")
                    .font(.footnote).foregroundStyle(.indigo)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func reload() async {
        guard let api = API.current else { error = APIError.notPaired.localizedDescription; return }
        do {
            detail = try await api.thread(threadID)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func act(_ item: Item, _ action: String) {
        Task {
            await model.act(item, action)
            if action == "reopen" { await reload() } else { dismiss() }
        }
    }
}

struct MessageCard: View {
    let message: Message
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(message.mine ? "You" : (message.from ?? message.fromAddr ?? "Unknown"))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let d = message.when {
                    Text(d.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let to = message.to, !to.isEmpty {
                Text("to " + to.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if let body = message.body, !body.isEmpty {
                Text(body)
                    .font(.callout)
                    .textSelection(.enabled)
                    .lineLimit(expanded ? nil : 14)
                    .fixedSize(horizontal: false, vertical: true)
                if body.count > 700 {
                    Button(expanded ? "Show less" : "Show all") { withAnimation { expanded.toggle() } }
                        .font(.caption.weight(.semibold))
                }
            }
            if let att = message.attachments, !att.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(att, id: \.self) { a in
                        Label(a, systemImage: "paperclip").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(message.mine ? Color.blue.opacity(0.12) : Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 14))
        .padding(message.mine ? .leading : .trailing, 28)
    }
}
