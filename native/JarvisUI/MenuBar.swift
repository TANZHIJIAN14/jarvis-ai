// The menu bar icon: a dot in a dashed ring. Grey while waiting for the wake word, blue ring
// while working in the background, with a green count for news and an amber one when Jarvis
// needs you (mockup: "1 · Idle: menu bar only").

import AppKit

enum MenuBarIcon {
  enum Badge {
    case news(Int)
    case needsYou(Int)
  }

  static func image(working: Bool, badge: Badge?) -> NSImage {
    let badgeWidth: CGFloat = badge == nil ? 0 : 20
    let size = NSSize(width: 16 + badgeWidth, height: 16)
    // Drawn on demand, so labelColor matches the menu bar's current appearance.
    let image = NSImage(size: size, flipped: false) { _ in
      let ink = NSColor.labelColor
      let idle = NSColor(hex: 0x8A929C)
      let active = working || badge != nil
      let center = NSPoint(x: 8, y: 8)

      let dot = NSBezierPath(ovalIn: NSRect(x: center.x - 3.2, y: center.y - 3.2, width: 6.4, height: 6.4))
      (active ? ink : idle).setFill()
      dot.fill()

      let ring = NSBezierPath(ovalIn: NSRect(x: center.x - 6.2, y: center.y - 6.2, width: 12.4, height: 12.4))
      ring.lineWidth = 1.3
      ring.setLineDash([3, 2.2], count: 2, phase: 0)
      (working ? NSColor(hex: 0x1C8FC4) : active ? ink : idle).setStroke()
      ring.stroke()

      if let badge {
        let (count, fill): (Int, NSColor) = switch badge {
        case .news(let n): (n, NSColor(hex: 0x1E7F52))
        case .needsYou(let n): (n, NSColor(hex: 0xB86E00))
        }
        let pill = NSBezierPath(roundedRect: NSRect(x: 19, y: 0, width: 16, height: 16), xRadius: 8, yRadius: 8)
        fill.setFill()
        pill.fill()
        let label = NSAttributedString(string: "\(count)", attributes: [
          .font: NSFont.systemFont(ofSize: 11, weight: .bold),
          .foregroundColor: NSColor.white,
        ])
        let textSize = label.size()
        label.draw(at: NSPoint(x: 27 - textSize.width / 2, y: 8 - textSize.height / 2))
      }
      return true
    }
    image.isTemplate = false
    return image
  }
}
