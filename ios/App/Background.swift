import Foundation
import BackgroundTasks

/// One app-refresh task: fetch the summary so the badge and the widget cache stay
/// current even when the app is not opened. iOS decides when (roughly every 30 min+).
enum Background {
    static let refreshID = "dance.duckduck.mailcoach.refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshID, using: nil) { task in
            handle(task)
        }
    }

    static func schedule() {
        let r = BGAppRefreshTaskRequest(identifier: refreshID)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(r)
    }

    private static func handle(_ task: BGTask) {
        schedule()
        let work = Task { @MainActor in
            await AppModel.shared.load()
            task.setTaskCompleted(success: AppModel.shared.error == nil)
        }
        task.expirationHandler = { work.cancel() }
    }
}
