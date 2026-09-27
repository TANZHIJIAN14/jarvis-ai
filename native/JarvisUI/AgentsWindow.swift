// The Agents window: every background task, managed by click and keyboard instead of voice.
// Sidebar grouped Needs you / Running / Queued / Done; the selected task's request, approval,
// result and activity; a note box; New task… (mockup: "Agents window" on the design canvas).

import AppKit
import SwiftUI

final class AgentsWindowController {
  private var window: NSWindow?
  private let model: JarvisModel
  private let send: ([String: Any]) -> Void

  init(model: JarvisModel, send: @escaping ([String: Any]) -> Void) {
    self.model = model
    self.send = send
  }

  func show(selecting taskId: Int? = nil) {
    if window == nil {
      let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 660),
                            styleMask: [.titled, .closable, .miniaturizable, .resizable],
                            backing: .buffered, defer: false)
      window.title = "Agents"
      window.isReleasedWhenClosed = false
      window.minSize = NSSize(width: 760, height: 480)
      window.center()
      self.window = window
    }
    window?.contentView = NSHostingView(rootView: AgentsView(model: model, send: send, initialSelection: taskId))
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

struct AgentsView: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  @State var selection: Int?
  @State private var search = ""
  @State private var showingNewTask = false
  @State private var toast = ""

  init(model: JarvisModel, send: @escaping ([String: Any]) -> Void, initialSelection: Int?) {
    self.model = model
    self.send = send
    _selection = State(initialValue: initialSelection)
  }

  private var groups: [(String, [TaskItem])] {
    let visible = model.tasks.values.filter { task in
      search.isEmpty || task.title.localizedCaseInsensitiveContains(search) || task.request.localizedCaseInsensitiveContains(search)
    }
    let waiting = Set([model.approval?.taskId].compactMap { $0 })
    let sorted = visible.sorted { $0.startedAt > $1.startedAt }
    return [
      ("Needs you", sorted.filter { waiting.contains($0.id) }),
      ("Running", sorted.filter { $0.status == "running" && !waiting.contains($0.id) }),
      ("Queued", sorted.filter { $0.status == "queued" }),
      ("Done", sorted.filter { $0.isFinished }),
    ].filter { !$0.1.isEmpty }
  }

  var body: some View {
    VStack(spacing: 0) {
      // A header bar in the view itself: SwiftUI toolbars don't appear in a plain AppKit window.
      HStack(spacing: 12) {
        Spacer()
        TextField("Search tasks", text: $search).textFieldStyle(.roundedBorder).frame(width: 200)
        Button("New task…") { showingNewTask = true }
          .buttonStyle(PrimaryButton())
          .keyboardShortcut("n")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      Divider()
      HStack(spacing: 0) {
        sidebar
        Divider()
        detail
      }
    }
    .sheet(isPresented: $showingNewTask) {
      NewTaskSheet { text, project in
        var command: [String: Any] = ["type": "task_new", "text": text]
        if !project.isEmpty { command["project"] = project }
        send(command)
      }
    }
    .overlay(alignment: .topTrailing) {
      if !toast.isEmpty {
        Text(toast)
          .font(.system(size: 13))
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
          .padding(16)
          .transition(.opacity)
      }
    }
    .frame(minWidth: 760, minHeight: 480)
    .onAppear { if selection == nil { selection = groups.first?.1.first?.id } }
  }

  private var sidebar: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if groups.isEmpty {
          Text(search.isEmpty ? "No background tasks yet." : "No tasks match.")
            .font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(8)
        }
        ForEach(groups, id: \.0) { name, tasks in
          VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondary).padding(.horizontal, 8)
            ForEach(tasks) { task in
              SidebarRow(task: task, waiting: model.approval?.taskId == task.id, selected: selection == task.id)
                .onTapGesture { selection = task.id }
            }
          }
        }
      }
      .padding(10)
    }
    .frame(width: 290)
    .background(Theme.text.opacity(0.03))
  }

  @ViewBuilder private var detail: some View {
    if let id = selection, let task = model.tasks[id] {
      TaskDetail(
        task: task,
        approval: model.approval?.taskId == id ? model.approval : nil,
        steps: model.taskSteps[id] ?? [],
        result: model.taskResults[id],
        files: model.taskFiles[id] ?? [],
        diff: model.taskDiffs[id] ?? "",
        send: send,
        copied: { text in
          withAnimation { toast = text }
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { withAnimation { toast = "" } }
        })
        .id(id)
    } else {
      VStack(spacing: 8) {
        Text("Background tasks show up here.").font(.system(size: 15))
        Text("Say “keep going in the background” while Jarvis works, or start one with New task… (⌘N).")
          .font(.system(size: 13)).foregroundStyle(Theme.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

private struct StatusDot: View {
  let status: String
  var waiting = false
  var size: CGFloat = 8
  var onAccent = false

  var body: some View {
    let color = onAccent ? Color.white : waiting ? Theme.needsYou : status == "running" ? Theme.running
      : status == "failed" ? Theme.failed : status == "done" ? Theme.done : Theme.secondary
    Group {
      // Shape as well as color: filled = running or needs you, hollow = done, dashed = queued.
      if waiting || status == "running" {
        Circle().fill(color)
      } else if status == "queued" {
        Circle().strokeBorder(color, style: StrokeStyle(lineWidth: 1.5, dash: [2.5, 2]))
      } else {
        Circle().strokeBorder(color, lineWidth: 1.5)
      }
    }
    .frame(width: size, height: size)
  }
}

private struct SidebarRow: View {
  let task: TaskItem
  let waiting: Bool
  let selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      StatusDot(status: task.status, waiting: waiting, onAccent: selected)
      VStack(alignment: .leading, spacing: 2) {
        Text(task.title).font(.system(size: 13, weight: waiting ? .semibold : .medium)).lineLimit(1)
        Text(subtitle).font(.system(size: 12)).lineLimit(1).opacity(selected ? 0.85 : 1)
          .foregroundStyle(selected ? Color.white : Theme.secondary)
      }
      Spacer(minLength: 0)
    }
    .foregroundStyle(selected ? Color.white : Theme.text)
    .padding(8)
    .background(selected ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: 8))
    .contentShape(Rectangle())
  }

  private var subtitle: String {
    if waiting { return "Waiting for your OK" }
    switch task.status {
    case "queued": return "Starts when a slot frees"
    case "running": return task.activity.isEmpty ? task.project : task.activity
    case "stopped": return "Stopped"
    case "failed": return "Ran into a problem"
    default: return task.project
    }
  }
}

private struct TaskDetail: View {
  let task: TaskItem
  let approval: Approval?
  let steps: [TaskStep]
  let result: String?
  let files: [FileChange]
  let diff: String
  var send: ([String: Any]) -> Void
  var copied: (String) -> Void
  @State private var note = ""

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          header
          VStack(alignment: .leading, spacing: 4) {
            Text(task.origin == "window" ? "Started from this window at \(time(task.startedAt))" : "Asked by voice at \(time(task.startedAt))")
              .font(.system(size: 12)).foregroundStyle(Theme.secondary)
            Text(task.request.isEmpty ? "—" : task.request).font(.system(size: 14)).textSelection(.enabled)
          }
          .padding(.horizontal, 14).padding(.vertical, 12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.text.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))

          if let approval { approvalCard(approval) }

          if let result, task.isFinished {
            VStack(alignment: .leading, spacing: 10) {
              Text("Result").font(.system(size: 13, weight: .semibold))
              MarkdownView(text: result, fontSize: 14)
            }
          }

          if !files.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
              FilesChanged(files: files)
              if !diff.isEmpty { DiffView(diff: diff) }
            }
          } else if task.isFinished && result != nil {
            Text("No files changed.").font(.system(size: 13)).foregroundStyle(Theme.secondary)
          }

          VStack(alignment: .leading, spacing: 8) {
            Text("Activity").font(.system(size: 13, weight: .semibold))
            if steps.isEmpty {
              Text(task.status == "queued" ? "Not started yet" : "Nothing yet").font(.system(size: 13)).foregroundStyle(Theme.secondary)
            }
            ForEach(steps) { step in
              HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(time(step.at)).font(.system(size: 13).monospacedDigit()).foregroundStyle(Theme.secondary).frame(width: 48, alignment: .leading)
                Text(step.tool).font(.system(size: 13)).foregroundStyle(Theme.secondary).frame(width: 80, alignment: .leading)
                Text(step.detail).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
              }
            }
          }
        }
        .padding(.horizontal, 32).padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      Divider()
      HStack(spacing: 8) {
        TextField(task.isFinished ? "Ask a follow-up, e.g. “add a test for the empty search”" : "Send a note, e.g. “skip the e2e tests”",
                  text: $note)
          .textFieldStyle(.roundedBorder)
          .onSubmit(sendNote)
        Button("Send", action: sendNote).disabled(note.trimmingCharacters(in: .whitespaces).isEmpty)
      }
      .padding(.horizontal, 20).padding(.vertical, 12)
    }
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 10) {
          StatusDot(status: task.status, waiting: approval != nil, size: 10)
          Text(task.title).font(.system(size: 22, weight: .semibold)).textSelection(.enabled)
        }
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
          Text("\(task.project) · \(statusText(now: timeline.date))").font(.system(size: 13)).foregroundStyle(Theme.secondary)
        }
      }
      Spacer()
      if task.isLive {
        Button("Stop") { send(["type": "task_stop", "taskId": task.id]) }
          .foregroundStyle(Theme.failed)
      }
      if let command = task.resumeCommand {
        Button("Copy resume command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command, forType: .string)
          copied("Copied: \(command)")
        }
      }
    }
  }

  private func approvalCard(_ approval: Approval) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(approval.question).font(.system(size: 13, weight: .semibold))
      if !approval.detail.isEmpty {
        Text(approval.detail).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
          .padding(.horizontal, 12).padding(.vertical, 9)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.text.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
      }
      Text(approval.destructive ? "This can't be undone." : "Jarvis is also asking out loud.")
        .font(.system(size: 12)).foregroundStyle(approval.destructive ? Theme.needsYouText : Theme.secondary)
      HStack(spacing: 8) {
        Button("Allow") { send(["type": "approve", "id": approval.id, "allow": true]) }.buttonStyle(PrimaryButton())
        Button("Deny") { send(["type": "approve", "id": approval.id, "allow": false]) }.buttonStyle(SecondaryButton())
        if let always = approval.always {
          Button("Always allow") { send(["type": "approve", "id": approval.id, "allow": true, "always": true]) }
            .buttonStyle(SecondaryButton())
            .help(always)
        }
      }
      if let always = approval.always {
        Text("Always allow: \(always)").font(.system(size: 12)).foregroundStyle(Theme.secondary)
      }
    }
    .padding(14)
    .background(Theme.needsYou.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.needsYou.opacity(0.28), lineWidth: 1))
  }

  private func statusText(now: Date) -> String {
    if approval != nil { return "waiting for your OK · \(elapsed(since: task.startedAt, now: now))" }
    switch task.status {
    case "queued": return "queued · waiting for a free slot"
    case "running": return "running · \(elapsed(since: task.startedAt, now: now))"
    case "done": return "done"
    case "failed": return "ran into a problem"
    default: return "stopped"
    }
  }

  private func sendNote() {
    let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    send(["type": "task_note", "taskId": task.id, "text": text])
    note = ""
  }
}

private struct NewTaskSheet: View {
  var start: (String, String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var project = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("New background task").font(.system(size: 15, weight: .semibold))
      TextField("What should Claude do?", text: $text, axis: .vertical)
        .lineLimit(3...6)
        .textFieldStyle(.roundedBorder)
      TextField("Project folder under ~/Documents (optional), e.g. jarvis-ai", text: $project)
        .textFieldStyle(.roundedBorder)
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Start") {
          start(text.trimmingCharacters(in: .whitespacesAndNewlines), project.trimmingCharacters(in: .whitespaces))
          dismiss()
        }
        .keyboardShortcut(.defaultAction)
        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(20)
    .frame(width: 460)
  }
}

private func time(_ date: Date) -> String {
  date.formatted(date: .omitted, time: .shortened)
}
