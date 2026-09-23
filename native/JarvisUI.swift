// Jarvis's face: a menu bar icon and a floating orb with a response panel.
// Pure display: the brain (Node) owns audio and Claude, and streams state over a local
// WebSocket. The message shapes match UiEvent / UiCommand in brain/src/jarvis.ts.
//
// Build: xcrun swiftc -O -swift-version 5 JarvisUI.swift -o bin/JarvisUI
// Run:   bin/JarvisUI --port 8765 --token <token>   (the brain launches it)

import AppKit
import SwiftUI

func argument(_ name: String) -> String? {
  guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[i + 1]
}

// MARK: - Model

final class JarvisModel: ObservableObject {
  @Published var state = "idle"
  @Published var followUp = false
  @Published var listeningSince = Date()
  @Published var level: Double = 0
  @Published var transcript = ""
  @Published var reply = ""
  @Published var tools: [String] = []
  @Published var notice = ""
  @Published var connected = false

  var hasCard: Bool { !transcript.isEmpty || !reply.isEmpty || !notice.isEmpty }

  func apply(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "state":
      state = event["state"] as? String ?? "idle"
      followUp = event["followUp"] as? Bool ?? false
      if state == "listening" {
        listeningSince = Date()
        level = 0
        if !followUp { reset() }
      }
    case "level":
      level = event["value"] as? Double ?? 0
    case "transcript":
      transcript = event["text"] as? String ?? ""
      reply = ""
      tools = []
      notice = ""
    case "reply_delta":
      reply += event["text"] as? String ?? ""
    case "tool":
      let name = event["name"] as? String ?? ""
      let detail = event["detail"] as? String ?? ""
      tools.append(detail.isEmpty ? name : "\(name) · \(detail)")
      if tools.count > 4 { tools.removeFirst(tools.count - 4) }
    case "reply_done":
      if let error = event["error"] as? String { notice = error }
    case "notice":
      notice = event["text"] as? String ?? ""
    default:
      break
    }
  }

  private func reset() {
    transcript = ""
    reply = ""
    tools = []
    notice = ""
  }
}

// MARK: - Connection to the brain

final class BrainConnection {
  private let url: URL
  private let model: JarvisModel
  private var task: URLSessionWebSocketTask?

  init(port: String, token: String, model: JarvisModel) {
    url = URL(string: "ws://127.0.0.1:\(port)/?token=\(token)")!
    self.model = model
  }

  func connect() {
    let task = URLSession.shared.webSocketTask(with: url)
    self.task = task
    task.resume()
    receive(task)
  }

  func send(_ type: String) {
    task?.send(.string("{\"type\":\"\(type)\"}")) { _ in }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        if case .string(let text) = message,
           let data = text.data(using: .utf8),
           let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          DispatchQueue.main.async {
            self.model.connected = true
            self.model.apply(event)
          }
        }
        self.receive(task)
      case .failure:
        DispatchQueue.main.async { self.model.connected = false }
        // The brain may still be starting, or restarting: retry.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.connect() }
      }
    }
  }
}

// MARK: - Views

struct Orb: View {
  @ObservedObject var model: JarvisModel

  private var tint: Color {
    switch model.state {
    case "listening": return Color(red: 0.2, green: 0.85, blue: 1.0)
    case "transcribing", "thinking": return Color(red: 0.45, green: 0.55, blue: 1.0)
    case "speaking": return Color(red: 0.55, green: 0.95, blue: 1.0)
    default: return Color(white: 0.6)
    }
  }

  var body: some View {
    TimelineView(.animation) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      Canvas { context, size in
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let base = min(size.width, size.height) * 0.28
        var pulse = 1.0
        switch model.state {
        case "listening": pulse = 1 + model.level * 0.45
        case "speaking": pulse = 1 + 0.08 * sin(t * 9) + 0.05 * sin(t * 13.7)
        case "thinking", "transcribing": pulse = 1 + 0.03 * sin(t * 2)
        default: pulse = 1
        }
        let r = base * pulse

        // Glow.
        let glow = Path(ellipseIn: CGRect(x: center.x - r * 1.9, y: center.y - r * 1.9, width: r * 3.8, height: r * 3.8))
        context.fill(glow, with: .radialGradient(
          Gradient(colors: [tint.opacity(0.45), tint.opacity(0)]),
          center: center, startRadius: r * 0.5, endRadius: r * 1.9))

        // Core.
        let core = Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
        context.fill(core, with: .radialGradient(
          Gradient(colors: [.white.opacity(0.95), tint, tint.opacity(0.35)]),
          center: CGPoint(x: center.x - r * 0.25, y: center.y - r * 0.3), startRadius: 0, endRadius: r * 1.2))

        // Thinking: HUD-style arcs circling the core.
        if model.state == "thinking" || model.state == "transcribing" {
          for i in 0..<3 {
            let radius = r * (1.35 + Double(i) * 0.22)
            let start = t * (1.2 + Double(i) * 0.5) * (i % 2 == 0 ? 1 : -1)
            var arc = Path()
            arc.addArc(center: center, radius: radius, startAngle: .radians(start),
                       endAngle: .radians(start + 1.6), clockwise: false)
            context.stroke(arc, with: .color(tint.opacity(0.8 - Double(i) * 0.2)),
                           style: StrokeStyle(lineWidth: 2, lineCap: .round))
          }
        }

        // Follow-up: a ring that closes over the 8 s answer window.
        if model.state == "listening" && model.followUp {
          let remaining = max(0, 1 - timeline.date.timeIntervalSince(model.listeningSince) / 8)
          var ring = Path()
          ring.addArc(center: center, radius: r * 1.45, startAngle: .degrees(-90),
                      endAngle: .degrees(-90 + 360 * remaining), clockwise: false)
          context.stroke(ring, with: .color(tint.opacity(0.7)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
      }
    }
    .frame(width: 110, height: 110)
    .opacity(model.connected ? 1 : 0.4)
  }
}

struct Card: View {
  @ObservedObject var model: JarvisModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !model.transcript.isEmpty {
        Text(model.transcript)
          .font(.system(size: 13))
          .foregroundStyle(.secondary)
          .lineLimit(3)
      }
      if !model.reply.isEmpty {
        ScrollViewReader { proxy in
          ScrollView {
            Text(model.reply)
              .font(.system(size: 14))
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .id("reply")
          }
          .frame(maxHeight: 260)
          .onChange(of: model.reply) { proxy.scrollTo("reply", anchor: .bottom) }
        }
      }
      if !model.tools.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(model.tools.enumerated()), id: \.offset) { _, tool in
            Label(tool, systemImage: "gearshape")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }
      if !model.notice.isEmpty {
        Text(model.notice)
          .font(.system(size: 12))
          .foregroundStyle(.orange)
          .lineLimit(4)
      }
    }
    .padding(14)
    .frame(width: 460, alignment: .leading)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
  }
}

struct JarvisView: View {
  @ObservedObject var model: JarvisModel
  var onOrbTap: () -> Void

  var body: some View {
    VStack(spacing: 4) {
      Orb(model: model)
        .contentShape(Circle())
        .onTapGesture(perform: onOrbTap)
        .help(model.state == "idle" ? "Talk to Jarvis" : "Stop")
      if model.hasCard {
        Card(model: model)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
      Spacer(minLength: 0)
    }
    .animation(.easeOut(duration: 0.2), value: model.hasCard)
    .frame(width: 480, height: 480, alignment: .top)
  }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
  let model = JarvisModel()
  var brain: BrainConnection!
  var panel: NSPanel!
  var statusItem: NSStatusItem!
  var hideTimer: Timer?
  var observation: Any?

  func applicationDidFinishLaunching(_ notification: Notification) {
    brain = BrainConnection(port: argument("--port") ?? "8765", token: argument("--token") ?? "", model: model)
    setUpStatusItem()
    setUpPanel()
    observation = model.$state.sink { [weak self] state in self?.stateChanged(state) }
    brain.connect()
  }

  private func setUpStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.button?.image = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "Jarvis")
    let menu = NSMenu()
    menu.addItem(withTitle: "Talk to Jarvis", action: #selector(talk), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Stop", action: #selector(stop), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Jarvis", action: #selector(quit), keyEquivalent: "q").target = self
    statusItem.menu = menu
  }

  private func setUpPanel() {
    panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 480),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.contentView = NSHostingView(rootView: JarvisView(model: model) { [weak self] in self?.orbTapped() })
    if let screen = NSScreen.main?.visibleFrame {
      panel.setFrameTopLeftPoint(NSPoint(x: screen.midX - 240, y: screen.maxY - 8))
    }
  }

  private func stateChanged(_ state: String) {
    statusItem.button?.image = NSImage(
      systemSymbolName: state == "idle" ? "waveform.circle" : "waveform.circle.fill",
      accessibilityDescription: "Jarvis")
    hideTimer?.invalidate()
    if state == "idle" {
      // Leave the last answer up long enough to read, then get out of the way.
      hideTimer = Timer.scheduledTimer(withTimeInterval: model.hasCard ? 6 : 1, repeats: false) { [weak self] _ in
        self?.panel.orderOut(nil)
      }
    } else {
      panel.orderFrontRegardless()
    }
  }

  private func orbTapped() {
    brain.send(model.state == "idle" ? "activate" : "stop")
  }

  @objc private func talk() { brain.send("activate") }
  @objc private func stop() { brain.send("stop") }
  @objc private func quit() {
    brain.send("quit")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
