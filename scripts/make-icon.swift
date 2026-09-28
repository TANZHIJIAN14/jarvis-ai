// Draws Jarvis's app icon, the Calm glass orb on a soft rounded square: make-icon.swift <out.png>
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
  // macOS icon grid: an 824 px rounded square centred in 1024.
  let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
  let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
  NSGradient(colors: [NSColor(srgbRed: 0.98, green: 0.98, blue: 0.99, alpha: 1), NSColor(srgbRed: 0.87, green: 0.89, blue: 0.92, alpha: 1)])!
    .draw(in: shape, angle: -90)
  NSColor.black.withAlphaComponent(0.08).setStroke()
  shape.lineWidth = 4
  shape.stroke()

  let center = NSPoint(x: 512, y: 512)
  let blue = NSColor(srgbRed: 0.36, green: 0.80, blue: 0.96, alpha: 1)
  // Glow, hairline ring, then the core lit from the top left.
  NSGradient(colors: [blue.withAlphaComponent(0.35), blue.withAlphaComponent(0)])!
    .draw(in: NSBezierPath(ovalIn: NSRect(x: center.x - 330, y: center.y - 330, width: 660, height: 660)), relativeCenterPosition: .zero)
  let ring = NSBezierPath(ovalIn: NSRect(x: center.x - 290, y: center.y - 290, width: 580, height: 580))
  NSColor.black.withAlphaComponent(0.07).setStroke()
  ring.lineWidth = 6
  ring.stroke()
  let core = NSBezierPath(ovalIn: NSRect(x: center.x - 190, y: center.y - 190, width: 380, height: 380))
  NSGraphicsContext.current?.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = blue.withAlphaComponent(0.55)
  shadow.shadowBlurRadius = 60
  shadow.shadowOffset = NSSize(width: 0, height: -30)
  shadow.set()
  blue.setFill()
  core.fill()
  NSGraphicsContext.current?.restoreGraphicsState()
  NSGradient(colorsAndLocations: (.white, 0), (blue, 0.52), (NSColor(srgbRed: 0.25, green: 0.69, blue: 0.88, alpha: 1), 1))!
    .draw(in: core, relativeCenterPosition: NSPoint(x: -0.24, y: 0.32))
  return true
}
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
