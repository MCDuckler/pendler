import SwiftUI

/// Pendler v1's palette (web/style.css), shared by app and widgets.
enum Brand {
    static let accent = Color(red: 0x2f / 255, green: 0x9e / 255, blue: 0x6b / 255)       // #2f9e6b
    static let accentDeep = Color(red: 0x22 / 255, green: 0x7e / 255, blue: 0x56 / 255)   // #227e56
    static let cream = Color(red: 0xfa / 255, green: 0xf9 / 255, blue: 0xf5 / 255)        // #faf9f5
    static let ink = Color(red: 0x13 / 255, green: 0x13 / 255, blue: 0x12 / 255)
    static let late = Color(red: 0xd9 / 255, green: 0x4f / 255, blue: 0x3d / 255)

    /// Line badge colour by product, like the PWA (RE blue, S green, U violet, tram red, bus brown, ICE terracotta).
    static func product(_ p: String?) -> Color {
        switch p {
        case "nationalExpress", "national": return Color(red: 0.78, green: 0.38, blue: 0.27)
        case "regional", "regionalExpress": return Color(red: 0.20, green: 0.42, blue: 0.78)
        case "suburban": return Color(red: 0.16, green: 0.62, blue: 0.36)
        case "subway": return Color(red: 0.45, green: 0.30, blue: 0.70)
        case "tram": return Color(red: 0.80, green: 0.22, blue: 0.22)
        case "bus": return Color(red: 0.55, green: 0.38, blue: 0.24)
        case "ferry": return Color(red: 0.15, green: 0.55, blue: 0.70)
        default: return .gray
        }
    }
}

struct LineBadge: View {
    let line: Line?
    var compact = false

    var body: some View {
        Text(line?.name ?? "Fuß")
            .font((compact ? Font.caption2 : Font.caption).weight(.bold))
            .lineLimit(1)
            .padding(.horizontal, compact ? 4 : 6)
            .padding(.vertical, compact ? 1 : 2)
            .foregroundStyle(.white)
            .background(Brand.product(line?.product), in: RoundedRectangle(cornerRadius: compact ? 4 : 6))
    }
}

/// "+4" in red, or nothing.
struct DelayText: View {
    let minutes: Int
    var body: some View {
        if minutes > 0 {
            Text("+\(minutes)").font(.caption.weight(.bold)).foregroundStyle(Brand.late)
        }
    }
}
