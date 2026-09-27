// The orb: 72 px, the only colorful element. Grows with your voice while listening,
// one thin spinning arc while thinking, a gentle pulse while speaking, amber while asking,
// and a closing ring during the 8 s follow-up window.

import SwiftUI

struct Orb: View {
  @ObservedObject var model: JarvisModel

  var body: some View {
    TimelineView(.animation) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      let color = Theme.orb(model.state)
      Canvas { context, size in
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        var core: CGFloat = 20 // radius of the 40 px core
        switch model.state {
        case "listening": core += CGFloat(model.level) * 6
        case "speaking": core += 1.5 * sin(t * 7) + 1 * sin(t * 11.3)
        case "asking": core += 1.2 * sin(t * 4)
        default: break
        }

        // Soft glow.
        let glow = Path(ellipseIn: CGRect(x: center.x - 36, y: center.y - 36, width: 72, height: 72))
        context.fill(glow, with: .radialGradient(
          Gradient(colors: [color.opacity(0.32), color.opacity(0)]),
          center: center, startRadius: 0, endRadius: 36))

        // Hairline ring.
        let ring = Path(ellipseIn: CGRect(x: center.x - 33, y: center.y - 33, width: 66, height: 66))
        context.stroke(ring, with: .color(Theme.text.opacity(0.07)), lineWidth: 1)

        // Core: lit from the top left.
        let body = Path(ellipseIn: CGRect(x: center.x - core, y: center.y - core, width: core * 2, height: core * 2))
        context.drawLayer { layer in
          layer.addFilter(.shadow(color: color.opacity(0.5), radius: 8, y: 4))
          layer.fill(body, with: .radialGradient(
            Gradient(stops: [.init(color: .white, location: 0), .init(color: color, location: 0.52), .init(color: color.opacity(0.85), location: 1)]),
            center: CGPoint(x: center.x - core * 0.24, y: center.y - core * 0.32), startRadius: 0, endRadius: core * 1.3))
        }

        // Thinking: one thin spinning arc.
        if model.state == "thinking" || model.state == "transcribing" {
          var arc = Path()
          let start = t * 2.4
          arc.addArc(center: center, radius: 28, startAngle: .radians(start), endAngle: .radians(start + 1.9), clockwise: false)
          context.stroke(arc, with: .color(color), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }

        // Follow-up: a ring that closes over the 8 s answer window.
        if model.state == "listening" && model.followUp {
          let remaining = max(0, 1 - timeline.date.timeIntervalSince(model.listeningSince) / 8)
          var closing = Path()
          closing.addArc(center: center, radius: 28, startAngle: .degrees(-90),
                         endAngle: .degrees(-90 + 360 * remaining), clockwise: false)
          context.stroke(closing, with: .color(color), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
      }
    }
    .frame(width: Theme.orbSize, height: Theme.orbSize)
    .opacity(model.connected ? 1 : 0.4)
    .accessibilityLabel("Jarvis, \(model.stateLabel)")
  }
}
