// Calm macOS glass: design tokens from the design doc's "Visual language" table.
// Every color adapts to the system light/dark appearance.

import AppKit
import SwiftUI

extension Color {
  // A color with separate light- and dark-appearance values (0xRRGGBB).
  init(light: UInt32, dark: UInt32) {
    self.init(nsColor: NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      return NSColor(hex: isDark ? dark : light)
    })
  }

  init(hex: UInt32) {
    self.init(nsColor: NSColor(hex: hex))
  }
}

extension NSColor {
  convenience init(hex: UInt32) {
    self.init(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1)
  }
}

enum Theme {
  // Panel: #FAFAFC at 88% over blur, 1 px border #000 at 8% (dark: #282B30, border #FFF at 10%).
  static let panel = Color(light: 0xFAFAFC, dark: 0x282B30)
  static let panelBorder = Color(nsColor: NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      ? NSColor.white.withAlphaComponent(0.10) : NSColor.black.withAlphaComponent(0.08)
  })
  static let card = Color(light: 0xFFFFFF, dark: 0x32363C)
  static let text = Color(light: 0x1C1F23, dark: 0xF2F4F6)
  static let secondary = Color(light: 0x5B6470, dark: 0xA3ABB5)
  static let running = Color(light: 0x1C8FC4, dark: 0x5CC3F0)
  static let needsYou = Color(light: 0xD98200, dark: 0xF0A53A)
  static let needsYouText = Color(light: 0x9A5A00, dark: 0xF0A53A)
  static let done = Color(light: 0x1E7F52, dark: 0x5CC98F)
  static let failed = Color(light: 0xB8412F, dark: 0xF07A66)
  static let primaryFill = Color(light: 0x1C1F23, dark: 0xF2F4F6)
  static let primaryText = Color(light: 0xFFFFFF, dark: 0x1C1F23)

  static let radius: CGFloat = 16
  static let panelWidth: CGFloat = 440
  static let orbSize: CGFloat = 72

  // Orb colors by state.
  static func orb(_ state: String) -> Color {
    switch state {
    case "listening", "transcribing": return Color(hex: 0x3BB8EE)
    case "thinking": return Color(hex: 0x6F7FE8)
    case "speaking": return Color(hex: 0x5CCBF5)
    case "asking": return Color(hex: 0xF0A53A)
    case "error": return Color(hex: 0xE5584A)
    default: return Color(hex: 0xA7B0BA)
    }
  }

  static let mono = Font.system(size: 12, design: .monospaced)
}
