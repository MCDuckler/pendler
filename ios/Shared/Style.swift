import SwiftUI

extension ItemKind {
    var color: Color {
        switch self {
        case .reply: return .blue
        case .todo: return .orange
        case .deadline: return .red
        case .waiting: return .gray
        case .fyi: return .teal
        }
    }
}

enum Links {
    static func item(_ id: String) -> URL {
        URL(string: "pendler://mail/item/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")!
    }
    static let today = URL(string: "pendler://mail")!
}

/// "Tomorrow", "Overdue 2d", "Fri" — red when overdue or within two days.
struct DueChip: View {
    let date: Date
    var compact = false

    var body: some View {
        let n = Dates.daysFromToday(date)
        let hot = n <= 2
        Text(Dates.dueLabel(date))
            .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
            .padding(.horizontal, compact ? 5 : 7)
            .padding(.vertical, compact ? 1 : 3)
            .foregroundStyle(hot ? Color.white : Color.red)
            .background(hot ? Color.red : Color.red.opacity(0.12), in: Capsule())
    }
}

/// 0 = nothing, 1–3 = growing dot.
struct UrgencyDot: View {
    let urgency: Int
    var body: some View {
        if urgency > 0 {
            Circle()
                .fill(urgency >= 3 ? Color.red : (urgency == 2 ? Color.orange : Color.secondary.opacity(0.5)))
                .frame(width: 8, height: 8)
        }
    }
}
