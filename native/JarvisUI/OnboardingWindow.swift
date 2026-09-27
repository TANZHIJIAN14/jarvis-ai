// First-run setup: one window, six steps, about two minutes (mockup: "Onboarding" on the
// design canvas). Welcome, Microphone, Claude Code, Models, Voice, Try it. Opens by itself
// until it has been finished once (the brain's `onboarded` setting).

import AppKit
import SwiftUI

final class OnboardingWindowController {
  private var window: NSWindow?
  private let model: JarvisModel
  private let send: ([String: Any]) -> Void

  init(model: JarvisModel, send: @escaping ([String: Any]) -> Void) {
    self.model = model
    self.send = send
  }

  func show() {
    if window == nil {
      let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 580),
                            styleMask: [.titled, .closable, .fullSizeContentView],
                            backing: .buffered, defer: false)
      window.titlebarAppearsTransparent = true
      window.titleVisibility = .hidden
      window.isReleasedWhenClosed = false
      window.center()
      window.contentView = NSHostingView(rootView: OnboardingView(model: model, send: send, step: 0) { [weak self] in
        self?.send(["type": "settings_set", "values": ["onboarded": true]])
        self?.window?.close()
      })
      self.window = window
    }
    send(["type": "claude_check"])
    send(["type": "mic_check"])
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

private let STEPS = ["Welcome", "Microphone", "Claude Code", "Models", "Voice", "Try it"]

struct OnboardingView: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  @State var step: Int
  var finish: () -> Void

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(STEPS.enumerated()), id: \.offset) { index, name in
          HStack(spacing: 10) {
            ZStack {
              if index < step {
                Circle().fill(Theme.done)
                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
              } else if index == step {
                Circle().fill(Theme.primaryFill)
                Text("\(index + 1)").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.primaryText)
              } else {
                Circle().strokeBorder(Theme.text.opacity(0.2), lineWidth: 1)
                Text("\(index + 1)").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondary)
              }
            }
            .frame(width: 20, height: 20)
            Text(name).font(.system(size: 13, weight: index == step ? .semibold : .regular))
              .foregroundStyle(index > step ? Theme.secondary : Theme.text)
          }
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(index == step ? Theme.text.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        }
        Spacer()
      }
      .padding(.horizontal, 16).padding(.top, 48).padding(.bottom, 20)
      .frame(width: 220)
      .background(Theme.text.opacity(0.03))
      Divider()
      VStack(alignment: .leading, spacing: 18) {
        content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        HStack {
          if step > 0 { Button("Back") { step -= 1 }.buttonStyle(SecondaryButton()) }
          Spacer()
          Button(step == 0 ? "Get started" : step == STEPS.count - 1 ? "Done" : "Continue") {
            if step == STEPS.count - 1 { finish() } else { step += 1 }
          }
          .buttonStyle(PrimaryButton())
          .disabled(!canContinue)
          .opacity(canContinue ? 1 : 0.4)
          .keyboardShortcut(.defaultAction)
        }
      }
      .padding(.horizontal, 44).padding(.top, 44).padding(.bottom, 28)
    }
    .font(.system(size: 14))
    .frame(width: 800, height: 580)
    .onChange(of: step) {
      if step == 1 { send(["type": "mic_check"]) }
      if step == 2 { send(["type": "claude_check"]) }
    }
  }

  private var canContinue: Bool {
    step != 1 || model.micOK // Microphone: locked until Jarvis can hear
  }

  @ViewBuilder private var content: some View {
    switch step {
    case 0: welcome
    case 1: microphone
    case 2: claudeCode
    case 3: models
    case 4: voice
    default: tryIt
    }
  }

  private var welcome: some View {
    VStack(alignment: .leading, spacing: 18) {
      Circle()
        .fill(RadialGradient(colors: [.white, Color(hex: 0x5CCBF5), Color(hex: 0x3FB1E0)], center: UnitPoint(x: 0.38, y: 0.34), startRadius: 0, endRadius: 40))
        .frame(width: 64, height: 64)
        .shadow(color: Color(hex: 0x5CCBF5).opacity(0.5), radius: 12, y: 6)
      Text("Meet Jarvis").font(.system(size: 26, weight: .semibold))
      Text("Say “Hey Jarvis” and talk. It answers out loud, and hands longer jobs to your Claude Code in the background, then tells you how they went.")
        .font(.system(size: 15)).lineSpacing(4).foregroundStyle(Theme.text.opacity(0.85))
      Text("Setup takes about two minutes: the microphone, a check that Claude Code is signed in, the voice, and a first try.")
        .font(.system(size: 13)).foregroundStyle(Theme.secondary)
    }
  }

  private var microphone: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Let Jarvis hear you").font(.system(size: 22, weight: .semibold))
      Text("Until you say “Hey Jarvis”, the microphone only feeds the wake word detector on this Mac. Nothing is recorded or sent anywhere.")
        .lineSpacing(4).foregroundStyle(Theme.text.opacity(0.85))
      HStack(spacing: 12) {
        Image(systemName: "mic")
        Text("Microphone")
        Spacer()
        if model.micOK {
          Text("Allowed").foregroundStyle(Theme.done)
        } else {
          Button("Check again") { send(["type": "mic_check"]) }.buttonStyle(SecondaryButton())
          Button("Open Privacy settings…") {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
          }
          .buttonStyle(PrimaryButton())
        }
      }
      .padding(.horizontal, 16).padding(.vertical, 14)
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
      Text(model.micOK ? "Jarvis can hear the microphone."
           : "macOS asks once, for the app you started Jarvis from. If you said no before, allow it under Privacy → Microphone, then check again.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
    }
  }

  private var claudeCode: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Your Claude Code").font(.system(size: 22, weight: .semibold))
      Text("Jarvis works through the claude command you already use, on your plan. It never sees your password or keys.")
        .lineSpacing(4).foregroundStyle(Theme.text.opacity(0.85))
      VStack(spacing: 0) {
        statusRow("claude command found", ok: model.claude?.installed, value: model.claude?.version.map { "v\($0)" } ?? "Not found")
        statusRow("Signed in", ok: model.claude?.loggedIn, value: model.claude?.loggedIn == true ? (model.claude?.plan.map { "\($0.capitalized) plan" } ?? "Yes") : "No")
        HStack {
          Text("Default folder")
          Spacer()
          Text(abbreviate(model.knownProjects.first { $0.kind == "default" }?.path ?? "~"))
            .font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
      }
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
      if let claude = model.claude, !claude.loggedIn {
        HStack(spacing: 10) {
          Text(claude.installed ? "Run claude once in Terminal to sign in:" : "Install Claude Code, then run:")
          Text("claude").font(.system(size: 13, design: .monospaced))
          Button("Copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("claude", forType: .string)
          }
          .buttonStyle(SecondaryButton())
          Button("Check again") { send(["type": "claude_check"]) }.buttonStyle(SecondaryButton())
        }
        .font(.system(size: 13))
      } else if model.claude == nil {
        HStack { ProgressView().controlSize(.small); Text("Checking…").foregroundStyle(Theme.secondary) }
      }
    }
  }

  private func statusRow(_ label: String, ok: Bool?, value: String) -> some View {
    HStack {
      Text(label)
      Spacer()
      if ok == nil { ProgressView().controlSize(.small) } else {
        Text(value).foregroundStyle(ok == true ? Theme.done : Theme.failed)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .overlay(alignment: .bottom) { Rectangle().fill(Theme.panelBorder).frame(height: 1) }
  }

  private var models: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Getting the models").font(.system(size: 22, weight: .semibold))
      Text("Everything that hears and speaks runs on this Mac, so a few models download once.")
        .lineSpacing(4).foregroundStyle(Theme.text.opacity(0.85))
      VStack(spacing: 0) {
        modelRow("Speech to text", status: model.whisperReady ? "Reusing OpenSuperWhisper's model" : "Model not found",
                 ok: model.whisperReady, note: "large-v3-turbo, already on this Mac. Nothing to download.")
        modelRow("Wake word and voice detection", status: "Done · 6 MB", ok: true, progress: 1)
        let k = model.kokoro
        modelRow("Jarvis's voice (Kokoro)",
                 status: k.done ? "Done · 310 MB" : k.failed ? "Couldn't download" : k.total > 0
                   ? "\(Int(k.loaded / 1_000_000)) of \(Int(k.total / 1_000_000)) MB" : "Starting…",
                 ok: k.done, progress: k.done ? 1 : k.total > 0 ? k.loaded / k.total : 0, last: true)
      }
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
      Text("You can carry on. Until the voice arrives, Jarvis speaks with the Apple system voice.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
    }
  }

  private func modelRow(_ label: String, status: String, ok: Bool, note: String? = nil, progress: Double? = nil, last: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(label)
        Spacer()
        Text(status).font(.system(size: 13)).foregroundStyle(ok ? Theme.done : Theme.secondary)
      }
      if let note { Text(note).font(.system(size: 12)).foregroundStyle(Theme.secondary) }
      if let progress {
        ProgressView(value: progress).tint(ok ? Theme.done : Color.accentColor)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .overlay(alignment: .bottom) { if !last { Rectangle().fill(Theme.panelBorder).frame(height: 1) } }
  }

  private var voice: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Pick a voice").font(.system(size: 22, weight: .semibold))
      VoicePicker(model: model, send: send, only: ["bm_george", "bm_daniel", "bm_lewis", "samantha"])
      Text("More voices, speed and wake sensitivity are in Settings.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
    }
  }

  private var tryIt: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Try it").font(.system(size: 22, weight: .semibold))
      Text("Say “Hey Jarvis, what can you do?”").foregroundStyle(Theme.text.opacity(0.85))
      VStack(spacing: 14) {
        Orb(model: model)
        if let last = model.thread.last {
          VStack(alignment: .leading, spacing: 6) {
            if !last.you.isEmpty {
              Text("“\(last.you)”").font(.system(size: 13)).foregroundStyle(Theme.secondary).frame(maxWidth: .infinity, alignment: .trailing)
            }
            Text(inline(last.reply)).font(.system(size: 15)).lineSpacing(3).lineLimit(5)
          }
        } else {
          Text(model.stateLabel).font(.system(size: 13)).foregroundStyle(Theme.secondary)
          Button("Or click to talk") { send(["type": "activate"]) }.buttonStyle(SecondaryButton())
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity)
      .background(Theme.text.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
      Text("After this, Jarvis lives in your menu bar. Hold F5 to talk when it's noisy.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
    }
  }
}
