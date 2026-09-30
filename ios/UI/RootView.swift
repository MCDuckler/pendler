import SwiftUI

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if let r = model.update, model.showUpdateBanner {
                UpdateBanner(release: r)
            }
            TabView(selection: $model.selectedTab) {
                TodayView()
                    .tabItem { Label("Today", systemImage: "tray.full") }
                    .badge(model.openCount)
                    .tag(0)
                CategoryListView(category: .waiting)
                    .tabItem { Label("Waiting", systemImage: "hourglass") }
                    .tag(1)
                CategoryListView(category: .fyi)
                    .tabItem { Label("FYI", systemImage: "info.circle") }
                    .tag(2)
                DoneView()
                    .tabItem { Label("Done", systemImage: "checkmark.circle") }
                    .tag(3)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(4)
            }
        }
        .sheet(item: $model.openThread) { t in
            NavigationStack { ThreadView(threadID: t.id) }
                .environmentObject(model)
        }
    }
}

/// Shown instead of a list when there is no server yet.
struct PairPrompt: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ContentUnavailableView {
            Label("Not paired", systemImage: "link.badge.plus")
        } description: {
            Text("Open the pairing link from your Mail Coach server on this phone, or enter the server and token in Settings.")
        } actions: {
            Button("Open Settings") { model.selectedTab = 4 }
                .buttonStyle(.borderedProminent)
        }
    }
}

/// Error line under the navigation bar, dismissable.
struct ErrorStrip: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let e = model.error {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(e).font(.footnote).lineLimit(2)
                Spacer()
                Button { model.error = nil } label: { Image(systemName: "xmark").font(.footnote.weight(.bold)) }
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
