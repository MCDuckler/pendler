import WidgetKit
import SwiftUI

@main
struct PendlerWidgetBundle: WidgetBundle {
    var body: some Widget {
        CommuteWidget()
        MailCoachWidget()
    }
}
