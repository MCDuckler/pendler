import SwiftUI

enum RootTab: Int { case heute, woche, navigator, mail, settings }

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var commute: CommuteModel

    var body: some View {
        VStack(spacing: 0) {
            if let r = model.update, model.showUpdateBanner {
                UpdateBanner(release: r)
            }
            TabView(selection: $model.selectedTab) {
                HeuteView()
                    .tabItem { Label("Heute", systemImage: "figure.walk.departure") }
                    .tag(RootTab.heute.rawValue)
                WocheView()
                    .tabItem { Label("Woche", systemImage: "calendar") }
                    .tag(RootTab.woche.rawValue)
                NavigatorView()
                    .tabItem { Label("Navigator", systemImage: "point.topleft.down.to.point.bottomright.curvepath") }
                    .tag(RootTab.navigator.rawValue)
                MailTabView()
                    .tabItem { Label("Mail", systemImage: "tray.full") }
                    .badge(model.openCount)
                    .tag(RootTab.mail.rawValue)
                SettingsView()
                    .tabItem { Label("Einstellungen", systemImage: "gearshape") }
                    .tag(RootTab.settings.rawValue)
            }
            .tint(Brand.accent)
        }
        .sheet(item: $model.openThread) { t in
            NavigationStack { ThreadView(threadID: t.id) }
                .environmentObject(model)
        }
    }
}

/// Mail Coach's four lists behind one tab.
struct MailTabView: View {
    @EnvironmentObject var model: AppModel
    @State private var section = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("Liste", selection: $section) {
                Text("Today").tag(0); Text("Waiting").tag(1); Text("FYI").tag(2); Text("Done").tag(3)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            switch section {
            case 1: CategoryListView(category: .waiting)
            case 2: CategoryListView(category: .fyi)
            case 3: DoneView()
            default: TodayView()
            }
        }
    }
}

/// Shown instead of a list when there is no mail server yet.
struct PairPrompt: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ContentUnavailableView {
            Label("Uni-Mail nicht gekoppelt", systemImage: "link.badge.plus")
        } description: {
            Text("Öffne den Kopplungslink von Mail Coach auf diesem iPhone oder trage Server und Token in den Einstellungen ein.")
        } actions: {
            Button("Einstellungen") { model.selectedTab = RootTab.settings.rawValue }
                .buttonStyle(.borderedProminent)
        }
    }
}

/// Error line under the navigation bar, dismissable.
struct ErrorStrip: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let e = model.error {
            ErrorBanner(text: e) { model.error = nil }
        }
    }
}
