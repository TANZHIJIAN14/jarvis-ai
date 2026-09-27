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
  var status: String // queued, running, done, failed, stopped
  var activity: String
  var startedAt: Date
  var reported: Bool
  var request: String
  var origin: String // voice, window
  var cwd: String
  var claudeSessionId: String?

  var isLive: Bool { status == "running" || status == "queued" }
  var isFinished: Bool { status == "done" || status == "failed" || status == "stopped" }
  var resumeCommand: String? {
    claudeSessionId.map { "cd \"\(cwd)\" && claude --resume \($0)" }
  }
}

struct TaskStep: Identifiable {
  let id = UUID()
  let tool: String
  let detail: String
  let at: Date
}

struct Approval {
  let id: Int
  let question: String
  let detail: String
  let destructive: Bool
  let taskId: Int?
  let always: String? // what "Always allow" saves, e.g. "Run “npm test” in jarvis-ai"
}

struct FileChange: Identifiable {
  var id: String { path }
  let path: String
  let added: Int
  let removed: Int
}

struct AllowRuleItem: Identifiable {
  let id: Int // position, for rule_remove
  let label: String
  let folder: String
}

// A past conversation in the History window (HistoryItem in brain/src/jarvis.ts).
struct HistoryItem: Identifiable {
  let id: Int
  let title: String?
  let summary: String?
  let project: String
  let cwd: String
  let startedAt: Date
  let lastActiveAt: Date
  let turns: Int
  let claudeSessionId: String?
  let current: Bool
  let task: Bool

  var displayTitle: String { title ?? "Untitled conversation" }
  var resumeCommand: String? {
    claudeSessionId.map { "cd \"\(cwd)\" && claude --resume \($0)" }
  }
}

struct HistoryTurn: Identifiable {
  let id = UUID()
  let at: Date
  let user: String
  let reply: String
  let tools: [String]
}

struct Report: Identifiable {
  let id: Int // the task's id
  let title: String
  let summary: String
  let files: [FileChange]
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
  @Published var taskSteps: [Int: [TaskStep]] = [:] // the Agents window's activity lists
  @Published var taskResults: [Int: String] = [:] // what each finished task reported
  @Published var taskFiles: [Int: [FileChange]] = [:]
  @Published var taskDiffs: [Int: String] = [:]
  @Published var rules: [AllowRuleItem] = []
  @Published var reports: [Report] = [] // finished background work to show
  @Published var connected = false
  @Published var history: [HistoryItem] = [] // the History window's current search results
  @Published var historyProjects: [String] = []
  @Published var historyDetail: (id: Int, turns: [HistoryTurn])?

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
        destructive: event["destructive"] as? Bool ?? false,
        taskId: event["taskId"] as? Int,
        always: event["always"] as? String)
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
        reported: event["reported"] as? Bool ?? false,
        request: event["request"] as? String ?? "",
        origin: event["origin"] as? String ?? "voice",
        cwd: event["cwd"] as? String ?? "",
        claudeSessionId: event["claudeSessionId"] as? String)
    case "task_step":
      guard let id = event["taskId"] as? Int else { return }
      taskSteps[id, default: []].append(TaskStep(
        tool: event["tool"] as? String ?? "",
        detail: event["detail"] as? String ?? "",
        at: Date(timeIntervalSince1970: (event["at"] as? Double ?? 0) / 1000)))
    case "task_report":
      guard let id = event["taskId"] as? Int else { return }
      reports.removeAll { $0.id == id }
      let files = (event["files"] as? [[String: Any]] ?? []).map { f in
        FileChange(path: f["path"] as? String ?? "", added: f["added"] as? Int ?? 0, removed: f["removed"] as? Int ?? 0)
      }
      reports.append(Report(id: id, title: event["title"] as? String ?? "", summary: event["summary"] as? String ?? "", files: files))
      taskResults[id] = event["summary"] as? String ?? ""
      taskFiles[id] = files
      taskDiffs[id] = event["diff"] as? String ?? ""
    case "rules":
      rules = (event["rules"] as? [[String: Any]] ?? []).enumerated().map { index, r in
        AllowRuleItem(id: index, label: r["label"] as? String ?? "", folder: r["folder"] as? String ?? "")
      }
    case "history_results":
      historyProjects = event["projects"] as? [String] ?? []
      history = (event["sessions"] as? [[String: Any]] ?? []).map { s in
        HistoryItem(
          id: s["id"] as? Int ?? 0,
          title: s["title"] as? String,
          summary: s["summary"] as? String,
          project: s["project"] as? String ?? "",
          cwd: s["cwd"] as? String ?? "",
          startedAt: date(s["startedAt"]),
          lastActiveAt: date(s["lastActiveAt"]),
          turns: s["turns"] as? Int ?? 0,
          claudeSessionId: s["claudeSessionId"] as? String,
          current: s["current"] as? Bool ?? false,
          task: s["task"] as? Bool ?? false)
      }
    case "history_detail":
      let turns = (event["turns"] as? [[String: Any]] ?? []).map { t in
        HistoryTurn(at: date(t["at"]), user: t["user"] as? String ?? "", reply: t["reply"] as? String ?? "",
                    tools: t["tools"] as? [String] ?? [])
      }
      historyDetail = (event["id"] as? Int ?? 0, turns)
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

  // Milliseconds since 1970, as the brain sends times.
  private func date(_ value: Any?) -> Date {
    Date(timeIntervalSince1970: ((value as? Double) ?? Double(value as? Int ?? 0)) / 1000)
  }

  private func updateLast(_ change: (inout Exchange) -> Void) {
    if thread.isEmpty { thread.append(Exchange(you: "")) }
    change(&thread[thread.count - 1])
  }
}
