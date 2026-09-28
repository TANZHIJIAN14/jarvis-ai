// Settings: five tabs that replace most of the README's environment variables (mockup:
// "Settings" on the design canvas). Every change goes to the brain as settings_set and applies
// right away; a setting fixed by a JARVIS_* environment variable shows as locked.

import AppKit
import SwiftUI

final class SettingsWindowController {
  private var window: NSWindow?
  private let model: JarvisModel
  private let send: ([String: Any]) -> Void

  init(model: JarvisModel, send: @escaping ([String: Any]) -> Void) {
    self.model = model
    self.send = send
  }

  func show() {
    if window == nil {
      let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 640),
                            styleMask: [.titled, .closable, .miniaturizable],
                            backing: .buffered, defer: false)
      window.title = "Settings"
      window.isReleasedWhenClosed = false
      window.center()
      window.contentView = NSHostingView(rootView: SettingsView(model: model, send: send, tab: "voice"))
      self.window = window
    }
    send(["type": "claude_check"])
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

private let TABS = [("general", "General"), ("voice", "Voice"), ("listening", "Listening"), ("tasks", "Background tasks"), ("privacy", "Privacy")]

struct SettingsView: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  @State var tab: String

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 4) {
        ForEach(TABS, id: \.0) { id, label in
          Button(label) { tab = id }
            .buttonStyle(.plain)
            .font(.system(size: 13, weight: tab == id ? .semibold : .regular))
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(tab == id ? Theme.text.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
      }
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          if !model.settingsLoaded {
            Text("Waiting for Jarvis…").foregroundStyle(Theme.secondary)
          } else {
            switch tab {
            case "general": GeneralTab(model: model, send: send)
            case "listening": ListeningTab(model: model, send: send)
            case "tasks": TasksTab(model: model, send: send)
            case "privacy": PrivacyTab(model: model, send: send)
            default: VoiceTab(model: model, send: send)
            }
          }
        }
        .padding(.horizontal, 40).padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .font(.system(size: 13))
    .frame(width: 780, height: 640)
  }
}

// A setting's binding: shows the brain's value, sends changes back.
private func binding<T>(_ model: JarvisModel, _ send: @escaping ([String: Any]) -> Void, _ key: String, _ fallback: T) -> Binding<T> {
  Binding(
    get: { model.setting(key, fallback) },
    set: { value in
      model.settings[key] = value
      send(["type": "settings_set", "values": [key: value]])
    })
}

// A row: a 180 px label (with an optional note), then the control.
private struct Row<Content: View>: View {
  let label: String
  var note: String?
  var locked = false
  @ViewBuilder var content: Content

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 2) {
        Text(label).font(.system(size: 13, weight: .semibold))
        if let note { Text(note).font(.system(size: 12)).foregroundStyle(Theme.secondary) }
        if locked { Text("Set by an environment variable").font(.system(size: 12)).foregroundStyle(Theme.needsYouText) }
      }
      .frame(width: 180, alignment: .leading)
      content.disabled(locked)
      Spacer(minLength: 0)
    }
  }
}

// A list box: rows separated by hairlines, in a rounded border.
private struct ListBox<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) { content }
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
  }
}

private struct ListRow<Content: View>: View {
  var last = false
  var highlighted = false
  @ViewBuilder var content: Content

  var body: some View {
    HStack(spacing: 12) { content }
      .padding(.horizontal, 14).padding(.vertical, 10)
      .background(highlighted ? Color.accentColor.opacity(0.06) : Color.clear)
      .overlay(alignment: .bottom) { if !last { Rectangle().fill(Theme.panelBorder).frame(height: 1) } }
  }
}

private struct GeneralTab: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void

  var body: some View {
    Row(label: "Claude") {
      if let claude = model.claude {
        Circle().fill(claude.loggedIn ? Theme.done : Theme.failed).frame(width: 8, height: 8)
        Text(claudeLine(claude))
        if !claude.loggedIn { Button("Check again") { send(["type": "claude_check"]) } }
      } else {
        ProgressView().controlSize(.small)
        Text("Checking…").foregroundStyle(Theme.secondary)
      }
    }
    Row(label: "Model for quick answers", locked: model.lockedSettings.contains("model")) {
      Picker("", selection: binding(model, send, "model", "")) {
        Text("Claude Code default").tag("")
        Text("Sonnet").tag("sonnet")
        Text("Haiku").tag("haiku")
        Text("Opus").tag("opus")
      }
      .labelsHidden()
      .frame(width: 200)
    }
    Row(label: "Open at login", note: "Starts Jarvis when you log in") {
      Toggle("", isOn: binding(model, send, "openAtLogin", false)).toggleStyle(.switch).labelsHidden()
    }
    Row(label: "Agents window") { Shortcut(text: "⇧⌘A") }
    Row(label: "History") { Shortcut(text: "⌘Y") }
  }

  private func claudeLine(_ claude: ClaudeStatus) -> String {
    if !claude.installed { return "The claude command isn't installed" }
    if !claude.loggedIn { return "Not signed in. Run claude once in Terminal." }
    let plan = claude.plan.map { " · \($0.capitalized) plan" } ?? ""
    return "Signed in through the claude CLI\(plan)"
  }
}

private struct Shortcut: View {
  let text: String
  var body: some View {
    Text(text).padding(.horizontal, 12).frame(height: 28)
      .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.text.opacity(0.15), lineWidth: 1))
  }
}

private struct VoiceTab: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  @State private var speed: Double?

  var body: some View {
    let locked = model.lockedSettings.contains("voice")
    VStack(alignment: .leading, spacing: 8) {
      Text("Jarvis's voice").font(.system(size: 13, weight: .semibold))
      if locked { Text("Set by an environment variable").font(.system(size: 12)).foregroundStyle(Theme.needsYouText) }
      VoicePicker(model: model, send: send).disabled(locked)
      if !model.kokoro.done {
        Text(model.kokoro.failed ? "The Kokoro voices couldn't load, so Jarvis uses Samantha."
             : "The Kokoro voices are still loading. Until then, Jarvis uses Samantha.")
          .font(.system(size: 12)).foregroundStyle(Theme.secondary)
      }
    }
    Row(label: "Speaking speed", locked: model.lockedSettings.contains("voiceSpeed")) {
      Text("Slower").font(.system(size: 12)).foregroundStyle(Theme.secondary)
      Slider(value: Binding(get: { speed ?? model.setting("voiceSpeed", 1.0) }, set: { speed = $0 }), in: 0.8...1.2, step: 0.05) { editing in
        if !editing, let speed { binding(model, send, "voiceSpeed", 1.0).wrappedValue = speed }
      }
      Text("Faster").font(.system(size: 12)).foregroundStyle(Theme.secondary)
      Text(String(format: "%.2f×", speed ?? model.setting("voiceSpeed", 1.0))).monospacedDigit().frame(width: 44, alignment: .trailing)
    }
    Row(label: "Call me “sir”", note: "Off keeps it plain") {
      Toggle("", isOn: binding(model, send, "sir", false)).toggleStyle(.switch).labelsHidden()
    }
  }
}

// The voice list with Sample buttons; also used in first-run setup.
struct VoicePicker: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  var only: [String]? // voice ids to show; nil = all

  var body: some View {
    let voices = model.voices.filter { only?.contains($0.id) ?? true }
    let selected = model.setting("voice", "bm_george")
    ListBox {
      ForEach(Array(voices.enumerated()), id: \.element.id) { index, voice in
        ListRow(last: index == voices.count - 1, highlighted: voice.id == selected) {
          Image(systemName: voice.id == selected ? "largecircle.fill.circle" : "circle")
            .foregroundStyle(voice.id == selected ? Color.accentColor : Theme.secondary)
          VStack(alignment: .leading, spacing: 1) {
            Text(voice.name).font(.system(size: 14))
            Text(voice.note).font(.system(size: 12)).foregroundStyle(Theme.secondary)
          }
          Spacer()
          Button {
            send(["type": "voice_sample", "voice": voice.id])
          } label: {
            Label("Sample", systemImage: "play.fill").font(.system(size: 12))
          }
          .buttonStyle(SecondaryButton())
          .accessibilityLabel("Play a sample of \(voice.name)")
        }
        .contentShape(Rectangle())
        .onTapGesture {
          model.settings["voice"] = voice.id
          send(["type": "settings_set", "values": ["voice": voice.id]])
        }
      }
    }
  }
}

private struct ListeningTab: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  @State private var sensitivity: Double?
  @State private var talkOverChanged = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Row(label: "Wake word sensitivity", locked: model.lockedSettings.contains("wakeThreshold")) {
        Text("Wakes easily").font(.system(size: 12)).foregroundStyle(Theme.secondary)
        Slider(value: Binding(get: { sensitivity ?? model.setting("wakeThreshold", 0.5) }, set: { sensitivity = $0 }), in: 0.3...0.8, step: 0.05) { editing in
          if !editing, let sensitivity { binding(model, send, "wakeThreshold", 0.5).wrappedValue = sensitivity }
        }
        Text("Strict").font(.system(size: 12)).foregroundStyle(Theme.secondary)
      }
      Text("Move it right if Jarvis wakes by mistake, from the TV or a meeting.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondary).padding(.leading, 196)
    }
    Row(label: "Talk over Jarvis", note: talkOverChanged ? "Takes effect when Jarvis next starts" : "Uses echo cancellation",
        locked: model.lockedSettings.contains("talkOver")) {
      Toggle("", isOn: Binding(get: { model.setting("talkOver", true) }, set: {
        talkOverChanged = true
        binding(model, send, "talkOver", true).wrappedValue = $0
      })).toggleStyle(.switch).labelsHidden()
    }
    Row(label: "Push to talk", note: "Hold F5 while you speak") {
      Toggle("", isOn: binding(model, send, "pushToTalk", true)).toggleStyle(.switch).labelsHidden()
      Text("Not Right Option: OpenSuperWhisper uses it").font(.system(size: 12)).foregroundStyle(Theme.secondary)
    }
    Row(label: "Time to reply") {
      Text("8 seconds after Jarvis finishes, no wake word needed")
    }
    Row(label: "Microphone") {
      Text("System default")
      Button("Sound settings…") {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Sound-Settings.extension?input")!)
      }
    }
  }
}

private struct TasksTab: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void

  var body: some View {
    Row(label: "Tasks at once", note: "Extra tasks wait in a queue") {
      Picker("", selection: binding(model, send, "maxTasks", 3)) {
        ForEach(1...4, id: \.self) { Text("\($0)").tag($0) }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: 180)
    }
    VStack(alignment: .leading, spacing: 10) {
      Text("What tasks may do without asking").font(.system(size: 13, weight: .semibold))
      ListBox {
        ListRow { Text("Read files and run read-only commands"); Spacer(); Text("Allowed").foregroundStyle(Theme.done) }
        ListRow { Text("Edit files, other commands and the web"); Spacer(); Text("Asks you first").foregroundStyle(Theme.needsYouText) }
        ListRow(last: true) { Text("Deleting, git push, sudo"); Spacer(); Text("Asks, and needs a click").foregroundStyle(Theme.failed) }
      }
      if model.rules.isEmpty {
        Text("“Always allow” choices you make show up here, with a Remove button.")
          .font(.system(size: 12)).foregroundStyle(Theme.secondary)
      } else {
        Text("Always allowed").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary).padding(.top, 4)
        ListBox {
          ForEach(model.rules) { rule in
            ListRow(last: rule.id == model.rules.count - 1) {
              Text(rule.label)
              Text(abbreviate(rule.folder)).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondary)
              Spacer()
              Button("Remove") { send(["type": "rule_remove", "index": rule.id]) }
            }
          }
        }
      }
    }
    VStack(alignment: .leading, spacing: 8) {
      Text("Projects Jarvis knows").font(.system(size: 13, weight: .semibold))
      Text("Say “switch to the … project”. Folders in ~/Documents always count.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
      ListBox {
        ForEach(Array(model.knownProjects.enumerated()), id: \.element.id) { index, project in
          ListRow(last: index == model.knownProjects.count - 1) {
            Text(abbreviate(project.path) == "~" ? "Home folder" : (project.path as NSString).lastPathComponent)
            if project.kind == "default" { Text("· default").foregroundStyle(Theme.secondary) }
            Spacer()
            Text(abbreviate(project.path)).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondary)
            if project.kind == "added" {
              Button("Remove") { setProjects(projects.filter { $0 != project.path }) }
            }
          }
        }
      }
      Button("Add project…") {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Add"
        if panel.runModal() == .OK, let url = panel.url { setProjects(projects + [url.path]) }
      }
    }
  }

  private var projects: [String] { model.setting("projects", [String]()) }

  private func setProjects(_ list: [String]) {
    send(["type": "settings_set", "values": ["projects": list]])
  }
}

private struct PrivacyTab: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  @State private var confirmClear = false

  var body: some View {
    HStack(spacing: 16) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Keep recordings for 7 days").font(.system(size: 13, weight: .semibold))
        Text("To check transcription mistakes. Off by default; turning it off deletes them.")
          .font(.system(size: 12)).foregroundStyle(Theme.secondary)
      }
      .frame(width: 320, alignment: .leading)
      Toggle("", isOn: binding(model, send, "keepRecordings", false)).toggleStyle(.switch).labelsHidden()
    }
    VStack(alignment: .leading, spacing: 6) {
      Text("What stays on this Mac").font(.system(size: 13, weight: .semibold))
      Text("The wake word, speech-to-text and the voice all run on this Mac. Only your words to Claude leave it.")
      HStack(spacing: 4) {
        Text("History and settings:")
        Text(abbreviate(model.dataDir)).font(.system(size: 12, design: .monospaced))
        Button("Show in Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: model.dataDir)) }.buttonStyle(.link)
      }
    }
    Button("Clear history…") { confirmClear = true }
      .foregroundStyle(Theme.failed)
      .alert("Clear all history?", isPresented: $confirmClear) {
        Button("Clear history", role: .destructive) { send(["type": "history_clear"]) }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("Jarvis forgets every past conversation and recording. Claude Code keeps its own transcripts.")
      }
  }
}

func abbreviate(_ path: String) -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}
