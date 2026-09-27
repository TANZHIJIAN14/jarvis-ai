// Jarvis's face, in the Calm macOS glass design: a menu bar icon, and a floating orb with
// the conversation panel under it. Pure display: the brain (Node) owns audio and Claude and
// streams state over a local WebSocket (UiEvent / UiCommand in brain/src/jarvis.ts).
//
// Build: npm run build:native (in brain/)
// Run:   bin/JarvisUI --port 8765 --token <token>   (the brain launches it; --open-agents / --open-history
//        open those windows, for development)

import AppKit
import Combine
import SwiftUI

func argument(_ name: String) -> String? {
  guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[i + 1]
}

struct JarvisView: View {
  @ObservedObject var model: JarvisModel
  var onOrbTap: () -> Void
  var onApprove: (Int, Bool, Bool) -> Void
  var onReportSeen: (Int) -> Void
  var onOpenAgents: (Int?) -> Void
  var send: ([String: Any]) -> Void

  var body: some View {
    VStack(spacing: 4) {
      Orb(model: model)
        .contentShape(Circle())
        .onTapGesture(perform: onOrbTap)
        .help(model.state == "idle" ? "Talk to Jarvis" : "Stop")
      statusLine
      if model.hasContent || model.state != "idle" {
        Panel(model: model, onApprove: onApprove, onReportSeen: onReportSeen, onOpenAgents: onOpenAgents, send: send)
          .padding(.top, 6)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
      Spacer(minLength: 0)
    }
    .animation(.easeOut(duration: 0.2), value: model.hasContent)
    .frame(width: Theme.panelWidth + 40, height: 620, alignment: .top)
  }

  // "jarvis-ai · Listening"
  private var statusLine: some View {
    HStack(spacing: 0) {
      if !model.project.isEmpty {
        Text("\(model.project) · ").foregroundStyle(Theme.secondary)
      }
      Text(model.stateLabel)
        .foregroundStyle(model.state == "asking" ? Theme.needsYouText : model.state == "error" ? Theme.failed
          : model.state == "idle" ? Theme.secondary : Theme.running)
    }
    .font(.system(size: 12))
    .padding(.horizontal, 10)
    .padding(.vertical, 3)
    .background(.ultraThinMaterial, in: Capsule())
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  let model = JarvisModel()
  var brain: BrainConnection!
  var agents: AgentsWindowController!
  var history: HistoryWindowController!
  var panel: NSPanel!
  var statusItem: NSStatusItem!
  var hideTimer: Timer?
  var observers = Set<AnyCancellable>()

  func applicationDidFinishLaunching(_ notification: Notification) {
    brain = BrainConnection(port: argument("--port") ?? "8765", token: argument("--token") ?? "", model: model)
    agents = AgentsWindowController(model: model) { [weak self] command in self?.brain.send(command) }
    history = HistoryWindowController(model: model, send: { [weak self] command in self?.brain.send(command) },
                                      openAgents: { [weak self] id in self?.agents.show(selecting: id) })
    setUpStatusItem()
    setUpPanel()
    model.$state.sink { [weak self] state in self?.stateChanged(state) }.store(in: &observers)
    model.objectWillChange
      .receive(on: RunLoop.main)
      .sink { [weak self] in self?.refreshMenuBar() }
      .store(in: &observers)
    brain.connect()
    if CommandLine.arguments.contains("--open-agents") { agents.show() } // for development
    if CommandLine.arguments.contains("--open-history") { history.show() }
  }

  private func setUpStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = MenuBarIcon.image(working: false, badge: nil)
    statusItem.button?.setAccessibilityLabel("Jarvis")
    rebuildMenu()
  }

  private func rebuildMenu() {
    let menu = NSMenu()
    let header = NSMenuItem(title: "Jarvis — say “Hey Jarvis”", action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Talk to Jarvis", action: #selector(talk), keyEquivalent: "").target = self
    for task in model.runningTasks {
      let item = NSMenuItem(title: "Working on: \(task.title)", action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    }
    if model.state != "idle" {
      menu.addItem(withTitle: "Stop", action: #selector(stop), keyEquivalent: "").target = self
    }
    menu.addItem(.separator())
    let agentsItem = NSMenuItem(title: "Agents Window", action: #selector(openAgents), keyEquivalent: "a")
    agentsItem.keyEquivalentModifierMask = [.command, .shift]
    agentsItem.target = self
    menu.addItem(agentsItem)
    let historyItem = NSMenuItem(title: "History", action: #selector(openHistory), keyEquivalent: "y")
    historyItem.target = self
    menu.addItem(historyItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Jarvis", action: #selector(quit), keyEquivalent: "q").target = self
    statusItem.menu = menu
  }

  private func refreshMenuBar() {
    // objectWillChange fires before the change lands; read the model on the next turn.
    DispatchQueue.main.async { [self] in
      let badge: MenuBarIcon.Badge? = model.approval != nil ? .needsYou(1)
        : model.unreportedFailure ? .failed(model.unreportedCount)
        : model.unreportedCount > 0 ? .news(model.unreportedCount) : nil
      statusItem.button?.image = MenuBarIcon.image(working: !model.runningTasks.isEmpty, badge: badge)
      rebuildMenu()
      // Jarvis opens itself when it needs you (an approval) or has something new to show.
      if model.approval != nil { showPanel() }
    }
  }

  private func setUpPanel() {
    panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: Theme.panelWidth + 40, height: 620),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.contentView = NSHostingView(rootView: JarvisView(
      model: model,
      onOrbTap: { [weak self] in self?.orbTapped() },
      onApprove: { [weak self] id, allow, always in
        self?.brain.send(["type": "approve", "id": id, "allow": allow, "always": always])
      },
      onReportSeen: { [weak self] id in
        self?.model.dismissReport(id)
        self?.brain.send(["type": "report_seen", "taskId": id])
      },
      onOpenAgents: { [weak self] id in self?.agents.show(selecting: id) },
      send: { [weak self] command in self?.brain.send(command) }))
    if let screen = NSScreen.main?.visibleFrame {
      panel.setFrameTopLeftPoint(NSPoint(x: screen.midX - (Theme.panelWidth + 40) / 2, y: screen.maxY - 8))
    }
  }

  private func stateChanged(_ state: String) {
    hideTimer?.invalidate()
    if state == "idle" {
      // Leave the last answer up long enough to read, then back to the menu bar.
      hideTimer = Timer.scheduledTimer(withTimeInterval: model.hasContent ? 8 : 1, repeats: false) { [weak self] _ in
        guard let self, self.model.state == "idle", self.model.approval == nil else { return }
        self.panel.orderOut(nil)
      }
    } else {
      showPanel()
    }
  }

  private func showPanel() {
    panel.orderFrontRegardless()
  }

  private func orbTapped() {
    brain.send(["type": model.state == "idle" ? "activate" : "stop"])
  }

  @objc private func talk() { brain.send(["type": "activate"]) }
  @objc func openAgents() { agents.show() }
  @objc func openHistory() { history.show() }
  @objc private func stop() { brain.send(["type": "stop"]) }
  @objc private func quit() {
    brain.send(["type": "quit"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
