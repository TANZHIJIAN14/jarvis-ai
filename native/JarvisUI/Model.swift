// What the UI shows, built from the brain's events (UiEvent in brain/src/jarvis.ts).

import Foundation

struct Exchange: Identifiable {
  let id = UUID()
  var you: String
  var reply = ""
  var activity = "" // "what Jarvis is doing": the latest tool, e.g. "Reading listener.ts"
  var steps = 0
  var finished = false
  var error: String?
}

struct TaskItem: Identifiable {
  let id: Int
  var title: String
  var project: String
  var status: String // running, done, failed, stopped
  var activity: String
  var startedAt: Date
  var reported: Bool
}

struct Approval {
  let id: Int
  let question: String
  let detail: String
  let destructive: Bool
}

struct Report: Identifiable {
  let id: Int // the task's id
  let title: String
  let summary: String
}

final class JarvisModel: ObservableObject {
  @Published var state = "idle"
  @Published var followUp = false
  @Published var listeningSince = Date()
  @Published var level: Double = 0
  @Published var project = ""
  @Published var sessionTitle: String?
  @Published var thread: [Exchange] = [] // the current conversation, newest last (only the last two show)
  @Published var notice = ""
  @Published var approval: Approval?
  @Published var tasks: [Int: TaskItem] = [:]
  @Published var reports: [Report] = [] // finished background work to show
  @Published var connected = false

  var runningTasks: [TaskItem] {
    tasks.values.filter { $0.status == "running" }.sorted { $0.startedAt < $1.startedAt }
  }

  // Finished tasks not yet told to the user: the green menu bar badge.
  var unreportedCount: Int {
    tasks.values.filter { ($0.status == "done" || $0.status == "failed") && !$0.reported }.count
  }

  var hasContent: Bool {
    !thread.isEmpty || !notice.isEmpty || approval != nil || !reports.isEmpty || !runningTasks.isEmpty
  }

  // "jarvis-ai · Listening"
  var stateLabel: String {
    switch state {
    case "listening": return followUp ? "Your turn" : "Listening"
    case "transcribing": return "Got it"
    case "thinking": return "Thinking"
    case "speaking": return "Speaking"
    case "asking": return "Waiting for your answer"
    default: return "Ready"
    }
  }

  func apply(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "state":
      state = event["state"] as? String ?? "idle"
      followUp = event["followUp"] as? Bool ?? false
      if state == "listening" {
        listeningSince = Date()
        level = 0
      }
    case "level":
      level = event["value"] as? Double ?? 0
    case "transcript":
      // A new exchange: what the user said, then Jarvis's reply below it.
      thread.append(Exchange(you: event["text"] as? String ?? ""))
      if thread.count > 2 { thread.removeFirst(thread.count - 2) }
      notice = ""
      reports.removeAll { report in tasks[report.id]?.reported ?? true }
    case "reply_delta":
      updateLast { $0.reply += event["text"] as? String ?? "" }
    case "tool":
      updateLast {
        $0.activity = event["activity"] as? String ?? ""
        $0.steps += 1
      }
    case "reply_done":
      updateLast {
        $0.finished = true
        $0.error = event["error"] as? String
      }
    case "notice":
      notice = event["text"] as? String ?? ""
    case "approval":
      approval = Approval(
        id: event["id"] as? Int ?? 0,
        question: event["question"] as? String ?? "",
        detail: event["detail"] as? String ?? "",
        destructive: event["destructive"] as? Bool ?? false)
    case "approval_done":
      if approval?.id == event["id"] as? Int { approval = nil }
    case "task":
      guard let id = event["id"] as? Int else { return }
      tasks[id] = TaskItem(
        id: id,
        title: event["title"] as? String ?? "Background task",
        project: event["project"] as? String ?? "",
        status: event["status"] as? String ?? "running",
        activity: event["activity"] as? String ?? "",
        startedAt: Date(timeIntervalSince1970: (event["startedAt"] as? Double ?? 0) / 1000),
        reported: event["reported"] as? Bool ?? false)
    case "task_report":
      guard let id = event["taskId"] as? Int else { return }
      reports.removeAll { $0.id == id }
      reports.append(Report(id: id, title: event["title"] as? String ?? "", summary: event["summary"] as? String ?? ""))
    case "session":
      project = (event["project"] as? String ?? "")
      sessionTitle = event["title"] as? String
    default:
      break
    }
  }

  func dismissReport(_ id: Int) {
    reports.removeAll { $0.id == id }
  }

  private func updateLast(_ change: (inout Exchange) -> Void) {
    if thread.isEmpty { thread.append(Exchange(you: "")) }
    change(&thread[thread.count - 1])
  }
}
