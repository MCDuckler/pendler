import SwiftUI

/// A strip above the tabs when a newer build is on the box.
struct UpdateBanner: View {
    @EnvironmentObject var model: AppModel
    let release: Release
    @State private var failed = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 1) {
                Text("Update \(release.version) ready").font(.footnote.weight(.semibold))
                Text(failed ? "SideStore not found — add the source in Settings" : (release.notes ?? release.size))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button("Update") { Task { failed = !(await Updates.install(release)) } }
                .font(.footnote.weight(.semibold))
            Button { withAnimation { model.dismissUpdate() } } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
            }
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.bar)
    }
}

/// Settings › App: what is running, what the box has, and the buttons.
struct UpdateSection: View {
    @EnvironmentObject var model: AppModel
    @State private var note: String?

    var body: some View {
        Section {
            LabeledContent("Installed", value: "\(Updates.runningVersion) (\(Updates.running))")
            if let r = model.update {
                LabeledContent("Latest", value: "\(r.version) (\(r.build))")
                if let n = r.notes { Text(n).font(.footnote).foregroundStyle(.secondary) }
            }
            if model.updateAvailable, let r = model.update {
                Button("Update to \(r.version) · \(r.size)") {
                    Task { note = (await Updates.install(r)) ? nil : "Could not open SideStore, AltStore or Safari." }
                }
            } else {
                Button {
                    Task { await model.checkForUpdate(force: true); note = model.updateAvailable ? nil : "You have the latest build." }
                } label: {
                    HStack { Text("Check for updates"); if model.checkingUpdate { Spacer(); ProgressView() } }
                }
            }
            Button("Add Mail Coach source to SideStore") {
                Task { note = (await Updates.addSource()) ? nil : "Could not open SideStore." }
            }
            if let note { Text(note).font(.footnote).foregroundStyle(.secondary) }
        } header: { Text("App") } footer: {
            Text("With the source added, SideStore lists new builds as updates by itself. The app also checks when opened (every 6 hours at most).")
        }
    }
}
