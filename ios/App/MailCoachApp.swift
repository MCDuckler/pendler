import SwiftUI

@main
struct MailCoachApp: App {
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var phase

    init() {
        Background.register()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onOpenURL { model.handle($0) }
                .task { await model.requestBadgePermission() }
        }
        .onChange(of: phase) { _, new in
            switch new {
            case .active:
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
