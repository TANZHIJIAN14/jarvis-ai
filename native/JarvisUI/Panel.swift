// The conversation panel (440 px Calm glass) under the orb: your words, Jarvis's reply,
// the what-Jarvis-is-doing line, background task lines, the approval card, report cards
// and a footer. Mockups: "Assistant states" boards 2–6 on the design canvas.

import AppKit
import SwiftUI

struct Panel: View {
  @ObservedObject var model: JarvisModel
  var onApprove: (Int, Bool, Bool) -> Void
  var onReportSeen: (Int) -> Void
  var onOpenAgents: (Int?) -> Void
  var send: ([String: Any]) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if model.state == "listening" && !model.partial.isEmpty {
        ListeningLine(words: model.partial)
      } else if model.state == "listening" && !model.followUp && model.thread.last?.reply.isEmpty != false && model.approval == nil {
        ListeningLine()
      }
      ForEach(Array(model.thread.enumerated()), id: \.element.id) { index, exchange in
        ExchangeView(exchange: exchange, isLatest: index == model.thread.count - 1)
      }
      if let error = model.error, model.state == "error" {
        ErrorCard(error: error, onRetry: { send(["type": "retry"]) })
      }
      ForEach(model.reports) { report in
        ReportCard(report: report, onDismiss: { onReportSeen(report.id) }, onDetails: { onOpenAgents(report.id) },
                   onTryAgain: {
                     send(["type": "task_note", "taskId": report.id, "text": "That didn't work. Try a different approach."])
                     onReportSeen(report.id)
                   })
      }
      if let approval = model.approval {
        ApprovalCard(approval: approval, onApprove: onApprove)
      }
      ForEach(model.runningTasks) { task in
        TaskLine(task: task) { onOpenAgents(task.id) }
      }
      if !model.notice.isEmpty {
        Text(model.notice).font(.system(size: 13)).foregroundStyle(Theme.secondary)
      }
      Footer(model: model) { onOpenAgents(nil) }
    }
    .padding(16)
    .frame(width: Theme.panelWidth, alignment: .leading)
    .background {
      ZStack {
        VisualEffect()
        Theme.panel.opacity(0.88)
      }
      .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }
    .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.panelBorder, lineWidth: 1))
    .shadow(color: .black.opacity(0.18), radius: 25, y: 16)
    .foregroundStyle(Theme.text)
  }
}

// "Listening…", then your words as they're recognised.
private struct ListeningLine: View {
  var words = ""

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "mic").foregroundStyle(Theme.running)
      Text(words.isEmpty ? "Listening…" : "\(words)…")
        .font(.system(size: 17))
        .foregroundStyle(words.isEmpty ? Theme.secondary : Theme.text)
        .animation(.easeOut(duration: 0.15), value: words)
    }
  }
}

private struct ExchangeView: View {
  let exchange: Exchange
  let isLatest: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !exchange.you.isEmpty {
        Text("“\(exchange.you)”")
          .font(.system(size: 13))
          .foregroundStyle(Theme.secondary)
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
      if !exchange.activity.isEmpty {
        HStack(spacing: 6) {
          if exchange.finished {
            Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold))
          } else {
            ProgressView().controlSize(.mini)
          }
          Text(exchange.finished && exchange.steps > 1 ? "\(exchange.activity) · \(exchange.steps) steps" : exchange.activity)
            .lineLimit(1)
        }
        .font(.system(size: 12))
        .foregroundStyle(Theme.secondary)
      }
      if !exchange.reply.isEmpty {
        ReplyText(text: exchange.reply, isLatest: isLatest)
      }
      if let error = exchange.error {
        Text(error).font(.system(size: 12)).foregroundStyle(Theme.failed).lineLimit(3)
      }
    }
  }
}

// The latest reply renders fully (tables, lists, code) and scrolls only when it's taller
// than the panel allows; an earlier reply collapses to two dimmed lines.
private struct ReplyText: View {
  let text: String
  let isLatest: Bool

  var body: some View {
    if isLatest {
      ViewThatFits(in: .vertical) {
        MarkdownView(text: text)
        ScrollViewReader { proxy in
          ScrollView {
            MarkdownView(text: text).id("end")
          }
          .onChange(of: text) { proxy.scrollTo("end", anchor: .bottom) }
        }
      }
      .frame(maxHeight: 360)
    } else {
      Text(inline(text.replacingOccurrences(of: "\n", with: " ")))
        .font(.system(size: 13))
        .lineLimit(2)
        .foregroundStyle(Theme.secondary)
    }
  }
}

private struct ApprovalCard: View {
  let approval: Approval
  var onApprove: (Int, Bool, Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(approval.question).font(.system(size: 15))
      VStack(alignment: .leading, spacing: 8) {
        if !approval.detail.isEmpty {
          Text(approval.detail)
            .font(.system(size: 13, design: .monospaced))
            .lineLimit(4)
            .textSelection(.enabled)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.text.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
        }
        HStack(spacing: 8) {
          Button("Allow") { onApprove(approval.id, true, false) }.buttonStyle(PrimaryButton())
          Button("Deny") { onApprove(approval.id, false, false) }.buttonStyle(SecondaryButton())
          Spacer()
          Text(approval.destructive ? "Can't be undone: needs a click" : "or just say yes or no")
            .font(.system(size: 12))
            .foregroundStyle(approval.destructive ? Theme.needsYouText : Theme.secondary)
        }
        if let always = approval.always {
          Button("Always allow: \(always)") { onApprove(approval.id, true, true) }
            .buttonStyle(.link)
            .font(.system(size: 12))
            .lineLimit(1)
        }
      }
      .padding(12)
      .background(Theme.needsYou.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.needsYou.opacity(0.28), lineWidth: 1))
    }
  }
}

// "I can't reach Claude right now…": the command to run, Try again (asks the kept question) and Open Terminal.
private struct ErrorCard: View {
  let error: ClaudeError
  var onRetry: () -> Void
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(error.text).font(.system(size: 15))
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
          Text(error.command).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
          Spacer()
          Button(copied ? "Copied" : "Copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(error.command, forType: .string)
            copied = true
          }
          .buttonStyle(SecondaryButton())
        }
        HStack(spacing: 8) {
          Button("Try again", action: onRetry).buttonStyle(PrimaryButton())
          Button("Open Terminal") {
            if let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") {
              NSWorkspace.shared.openApplication(at: terminal, configuration: NSWorkspace.OpenConfiguration())
            }
          }
          .buttonStyle(SecondaryButton())
        }
      }
      .padding(12)
      .background(Theme.failed.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.failed.opacity(0.25), lineWidth: 1))
    }
  }
}

private struct ReportCard: View {
  let report: Report
  var onDismiss: () -> Void
  var onDetails: () -> Void
  var onTryAgain: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Circle().strokeBorder(report.failed ? Theme.failed : Theme.done, lineWidth: 1.5).frame(width: 8, height: 8)
        Text(report.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        Spacer()
        Button("Details", action: onDetails).buttonStyle(.link).font(.system(size: 12))
        Button("Dismiss", action: onDismiss).buttonStyle(.link).font(.system(size: 12))
      }
      Text(report.summary)
        .font(.system(size: 13))
        .lineLimit(6)
        .textSelection(.enabled)
      if !report.files.isEmpty {
        FilesChanged(files: report.files, limit: 3)
      }
      if report.failed {
        Button("Try a different approach", action: onTryAgain).buttonStyle(SecondaryButton()).padding(.top, 4)
      }
    }
    .padding(12)
    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
  }
}

private struct TaskLine: View {
  let task: TaskItem
  var onDetails: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Circle().fill(Theme.running).frame(width: 8, height: 8)
      VStack(alignment: .leading, spacing: 2) {
        Text(task.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        Text(task.activity.isEmpty ? "In the background" : "In the background · \(task.activity)")
          .font(.system(size: 12))
          .foregroundStyle(Theme.secondary)
          .lineLimit(1)
      }
      Spacer()
      TimelineView(.periodic(from: .now, by: 1)) { timeline in
        Text(elapsed(since: task.startedAt, now: timeline.date))
          .font(.system(size: 12).monospacedDigit())
          .foregroundStyle(Theme.secondary)
      }
      Button("Details", action: onDetails).buttonStyle(.link).font(.system(size: 12))
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
  }
}

private struct Footer: View {
  @ObservedObject var model: JarvisModel
  var onOpenAgents: () -> Void

  var body: some View {
    let running = model.runningTasks.count
    HStack {
      Text(running == 0 ? "Nothing running in the background"
           : running == 1 ? "1 task in the background" : "\(running) tasks in the background")
      Spacer()
      if model.state == "listening" && !model.followUp {
        Text("Say “never mind” to cancel")
      } else if model.approval != nil {
        Text("Jarvis needs you")
      } else {
        Button("Agents window", action: onOpenAgents).buttonStyle(.link)
      }
    }
    .font(.system(size: 12))
    .foregroundStyle(Theme.secondary)
    .padding(.top, 10)
    .overlay(alignment: .top) { Rectangle().fill(Theme.panelBorder).frame(height: 1) }
  }
}

// "2 files changed": each file with its +added −removed, in SF Mono.
struct FilesChanged: View {
  let files: [FileChange]
  var limit = Int.max

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(files.count == 1 ? "1 file changed" : "\(files.count) files changed")
        .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
      ForEach(files.prefix(limit)) { file in
        HStack(spacing: 8) {
          Text(file.path).font(.system(size: 12, design: .monospaced)).lineLimit(1).truncationMode(.head)
          Spacer(minLength: 4)
          Text("+\(file.added)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.done)
          Text("−\(file.removed)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.failed)
        }
      }
      if files.count > limit {
        Text("and \(files.count - limit) more").font(.system(size: 12)).foregroundStyle(Theme.secondary)
      }
    }
  }
}

// A unified diff with added lines in green and removed lines in red.
struct DiffView: View {
  let diff: String
  @State private var width: CGFloat = 0

  var body: some View {
    let lines = diff.components(separatedBy: "\n")
    ScrollView(.horizontal, showsIndicators: false) {
      // At least as wide as the box, so added and removed rows are tinted edge to edge.
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
          Text(line.isEmpty ? " " : line)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(color(line))
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background(line))
        }
      }
      .padding(.vertical, 8)
      .frame(minWidth: width, alignment: .leading)
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .textSelection(.enabled)
    .background(Theme.text.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
  }

  private func color(_ line: String) -> Color {
    if line.hasPrefix("+++") || line.hasPrefix("---") { return Theme.text }
    if line.hasPrefix("+") { return Theme.done }
    if line.hasPrefix("-") { return Theme.failed }
    if line.hasPrefix("@@") { return Theme.running }
    return Theme.secondary
  }

  private func background(_ line: String) -> Color {
    if line.hasPrefix("+") && !line.hasPrefix("+++") { return Theme.done.opacity(0.08) }
    if line.hasPrefix("-") && !line.hasPrefix("---") { return Theme.failed.opacity(0.08) }
    return .clear
  }
}

struct PrimaryButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13))
      .padding(.horizontal, 14)
      .frame(height: 30)
      .foregroundStyle(Theme.primaryText)
      .background(Theme.primaryFill.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 7))
  }
}

struct SecondaryButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13))
      .padding(.horizontal, 12)
      .frame(height: 30)
      .foregroundStyle(Theme.text)
      .background(Theme.text.opacity(configuration.isPressed ? 0.08 : 0), in: RoundedRectangle(cornerRadius: 7))
      .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.text.opacity(0.15), lineWidth: 1))
  }
}

// The native blur behind the panel; follows the system light/dark setting.
struct VisualEffect: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .popover
    view.blendingMode = .behindWindow
    view.state = .active
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

func elapsed(since start: Date, now: Date) -> String {
  let seconds = max(0, Int(now.timeIntervalSince(start)))
  return String(format: "%d:%02d", seconds / 60, seconds % 60)
}
