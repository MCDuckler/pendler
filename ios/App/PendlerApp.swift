import SwiftUI

@main
struct PendlerApp: App {
    @StateObject private var model = AppModel.shared
    @StateObject private var commute = CommuteModel.shared
    @Environment(\.scenePhase) private var phase

    init() {
        Background.register()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(commute)
                .onOpenURL { model.handle($0) }
                .task { await commute.requestNotificationPermission() }
        }
        .onChange(of: phase) { _, new in
            switch new {
            case .active:
                Task { await commute.refresh() }
                Task { await model.load() }
                Task { await model.checkForUpdate() }
            case .background:
                Background.schedule()
            default:
                break
            }
        }
    }
}
