// The History window: find any past conversation and pick it back up. Sidebar grouped by day
// with project filters and a search over everything said; the selected conversation's summary
// (open items in amber) and transcript; Continue with Jarvis and Copy resume command
// (mockup: "History window" on the design canvas). The brain searches its SQLite index.

import AppKit
import SwiftUI

final class HistoryWindowController {
  private var window: NSWindow?
  private let model: JarvisModel
  private let send: ([String: Any]) -> Void
  private let openAgents: (Int) -> Void

  init(model: JarvisModel, send: @escaping ([String: Any]) -> Void, openAgents: @escaping (Int) -> Void) {
    self.model = model
    self.send = send
    self.openAgents = openAgents
  }

  func show() {
    if window == nil {
      let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 700),
                            styleMask: [.titled, .closable, .miniaturizable, .resizable],
                            backing: .buffered, defer: false)
      window.title = "History"
      window.isReleasedWhenClosed = false
      window.minSize = NSSize(width: 760, height: 480)
      window.center()
      window.contentView = NSHostingView(rootView: HistoryView(model: model, send: send, openAgents: openAgents))
      self.window = window
    }
    send(["type": "history_query", "query": ""])
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }

  var isVisible: Bool { window?.isVisible ?? false }
}

struct HistoryView: View {
  @ObservedObject var model: JarvisModel
  var send: ([String: Any]) -> Void
  var openAgents: (Int) -> Void
  @State private var query = ""
  @State private var project: String?
  @State private var selection: Int?
  @State private var toast = ""

  private var groups: [(String, [HistoryItem])] {
    let calendar = Calendar.current
    let now = Date()
    func group(_ date: Date) -> String {
      if calendar.isDateInToday(date) { return "Today" }
      if calendar.isDateInYesterday(date) { return "Yesterday" }
      if now.timeIntervalSince(date) < 7 * 86_400 { return "This week" }
      return date.formatted(.dateTime.month(.wide).year())
    }
    var order: [String] = []
    var byGroup: [String: [HistoryItem]] = [:]
    for item in model.history {
      let name = group(item.lastActiveAt)
      if byGroup[name] == nil { order.append(name) }
      byGroup[name, default: []].append(item)
    }
    return order.map { ($0, byGroup[$0]!) }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Spacer()
        HStack(spacing: 6) {
          Image(systemName: "magnifyingglass").foregroundStyle(Theme.secondary)
          TextField("Search everything said", text: $query)
            .textFieldStyle(.plain)
            .onChange(of: query) { search() }
        }
        .padding(.horizontal, 10)
        .frame(width: 260, height: 28)
        .background(Theme.text.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
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
    .onChange(of: model.history.map(\.id)) {
      if selection == nil || !model.history.contains(where: { $0.id == selection }) { selection = model.history.first?.id }
    }
    .onChange(of: selection) { if let selection { send(["type": "history_open", "id": selection]) } }
    // A new turn or a new title: refresh the list the user is looking at.
    .onChange(of: model.sessionTitle) { search() }
  }

  private func search() {
    var command: [String: Any] = ["type": "history_query", "query": query]
    if let project { command["project"] = project }
    send(command)
  }

  private var sidebar: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        FlowChips(options: ["All projects"] + model.historyProjects, selected: project ?? "All projects") { choice in
          project = choice == "All projects" ? nil : choice
          search()
        }
        if model.history.isEmpty {
          Text(query.isEmpty ? "No conversations yet. Say “Hey Jarvis” to start one." : "Nothing matches “\(query)”.")
            .font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(8)
        }
        ForEach(groups, id: \.0) { name, items in
          VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondary).padding(.horizontal, 8)
            ForEach(items) { item in
              HistoryRow(item: item, selected: selection == item.id).onTapGesture { selection = item.id }
            }
          }
        }
      }
      .padding(10)
    }
    .frame(width: 320)
    .background(Theme.text.opacity(0.03))
  }

  @ViewBuilder private var detail: some View {
    if let id = selection, let item = model.history.first(where: { $0.id == id }) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          header(item)
          if let summary = item.summary, !summary.isEmpty { SummaryBox(summary: summary) }
          VStack(alignment: .leading, spacing: 14) {
            Text("Conversation").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
            if let detail = model.historyDetail, detail.id == id {
              ForEach(detail.turns) { turn in TurnView(turn: turn) }
            } else {
              ProgressView().controlSize(.small)
            }
            if item.task {
              Button { openAgents(item.id) } label: {
                HStack(spacing: 10) {
                  Circle().strokeBorder(Theme.done, lineWidth: 1.5).frame(width: 8, height: 8)
                  Text("Background task").font(.system(size: 13))
                  Spacer()
                  Text("Open in Agents window").font(.system(size: 12)).foregroundStyle(Color.accentColor)
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
          }
          Text("Audio isn't kept. Jarvis keeps only the words, in ~/Library/Application Support/Jarvis.")
            .font(.system(size: 12)).foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 32).padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .id(id)
    } else {
      VStack(spacing: 8) {
        Text("Your conversations with Jarvis show up here.").font(.system(size: 15))
        Text("Pick one to read it again or carry on where you left off.")
          .font(.system(size: 13)).foregroundStyle(Theme.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func header(_ item: HistoryItem) -> some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(item.displayTitle).font(.system(size: 22, weight: .semibold)).textSelection(.enabled)
        Text(meta(item)).font(.system(size: 13)).foregroundStyle(Theme.secondary)
      }
      Spacer()
      if item.current {
        Text("Hey Jarvis continues this one").font(.system(size: 12)).foregroundStyle(Theme.secondary).padding(.top, 7)
      } else if !item.task {
        Button("Continue with Jarvis") {
          send(["type": "history_continue", "id": item.id])
          show("Your next “Hey Jarvis” continues “\(item.displayTitle)”")
          search()
        }
        .buttonStyle(PrimaryButton())
      }
      if let command = item.resumeCommand {
        Button("Copy resume command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command, forType: .string)
          show("Copied: \(command)")
        }
        .buttonStyle(SecondaryButton())
      }
    }
  }

  private func meta(_ item: HistoryItem) -> String {
    let minutes = Int(item.lastActiveAt.timeIntervalSince(item.startedAt) / 60)
    let length = minutes < 1 ? "under a minute" : minutes == 1 ? "1 min" : "\(minutes) min"
    let turns = item.turns == 1 ? "1 turn" : "\(item.turns) turns"
    return "\(item.project) · \(item.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(length) · \(turns)"
  }

  private func show(_ text: String) {
    withAnimation { toast = text }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { withAnimation { toast = "" } }
  }
}

private struct HistoryRow: View {
  let item: HistoryItem
  let selected: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 8) {
        Text(item.displayTitle).font(.system(size: 13, weight: .medium)).lineLimit(1)
        Spacer(minLength: 0)
        Text(when).font(.system(size: 12).monospacedDigit()).foregroundStyle(selected ? Color.white.opacity(0.85) : Theme.secondary)
      }
      Text(sub).font(.system(size: 12)).lineLimit(1).foregroundStyle(selected ? Color.white.opacity(0.85) : Theme.secondary)
    }
    .foregroundStyle(selected ? Color.white : Theme.text)
    .padding(.horizontal, 10).padding(.vertical, 8)
    .background(selected ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: 8))
    .contentShape(Rectangle())
  }

  private var when: String {
    let calendar = Calendar.current
    if calendar.isDateInToday(item.lastActiveAt) || calendar.isDateInYesterday(item.lastActiveAt) {
      return item.lastActiveAt.formatted(date: .omitted, time: .shortened)
    }
    if Date().timeIntervalSince(item.lastActiveAt) < 7 * 86_400 { return item.lastActiveAt.formatted(.dateTime.weekday(.abbreviated)) }
    return item.lastActiveAt.formatted(.dateTime.day().month(.abbreviated))
  }

  private var sub: String {
    let turns = item.turns == 1 ? "1 turn" : "\(item.turns) turns"
    return [item.project, turns, item.current ? "current" : nil, item.task ? "background task" : nil]
      .compactMap { $0 }.joined(separator: " · ")
  }
}

// The summary, with each "Open: …" line from the summarizer in amber.
private struct SummaryBox: View {
  let summary: String

  var body: some View {
    let lines = summary.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let open = lines.filter { $0.hasPrefix("Open:") }
    let text = lines.filter { !$0.hasPrefix("Open:") }.joined(separator: " ")
    VStack(alignment: .leading, spacing: 8) {
      Text("Summary").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
      if !text.isEmpty { Text(inline(text)).font(.system(size: 14)).lineSpacing(3).textSelection(.enabled) }
      ForEach(open, id: \.self) { line in
        Text(line).font(.system(size: 13)).foregroundStyle(Theme.needsYouText).textSelection(.enabled)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.text.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
  }
}

// One turn: your words, what Jarvis did, and its reply, each in its own style.
private struct TurnView: View {
  let turn: HistoryTurn

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 14) {
      Text(turn.at.formatted(date: .omitted, time: .shortened))
        .font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.secondary)
        .frame(width: 56, alignment: .leading)
      VStack(alignment: .leading, spacing: 6) {
        if !turn.user.isEmpty {
          Text("You: “\(turn.user)”").font(.system(size: 13)).foregroundStyle(Theme.secondary).textSelection(.enabled)
        }
        if !turn.tools.isEmpty {
          Text(tools).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondary).lineLimit(3)
        }
        if !turn.reply.isEmpty { MarkdownView(text: turn.reply, fontSize: 14) }
      }
    }
  }

  private var tools: String {
    let shown = turn.tools.prefix(4).joined(separator: " · ")
    return turn.tools.count > 4 ? "\(shown) · \(turn.tools.count - 4) more" : shown
  }
}

// Filter chips that wrap onto more lines when there are many projects.
private struct FlowChips: View {
  let options: [String]
  let selected: String
  var pick: (String) -> Void

  var body: some View {
    WrapLayout(spacing: 6) {
      ForEach(options, id: \.self) { option in
        let on = option == selected
        Button(option) { pick(option) }
          .buttonStyle(.plain)
          .font(.system(size: 12))
          .padding(.horizontal, 10)
          .frame(height: 26)
          .foregroundStyle(on ? Theme.primaryText : Theme.text)
          .background(on ? Theme.primaryFill : Color.clear, in: Capsule())
          .overlay(Capsule().strokeBorder(on ? Color.clear : Theme.text.opacity(0.15), lineWidth: 1))
      }
    }
    .padding(.horizontal, 4)
  }
}

private struct WrapLayout: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
    return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for row in arrange(width: bounds.width, subviews: subviews) {
      for (index, x) in row.items {
        subviews[index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + row.y), proposal: .unspecified)
      }
    }
  }

  private func arrange(width: CGFloat, subviews: Subviews) -> [(items: [(Int, CGFloat)], y: CGFloat, width: CGFloat, height: CGFloat)] {
    var rows: [(items: [(Int, CGFloat)], y: CGFloat, width: CGFloat, height: CGFloat)] = []
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
    var items: [(Int, CGFloat)] = []
    for (index, subview) in subviews.enumerated() {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        rows.append((items, y, x - spacing, rowHeight))
        y += rowHeight + spacing
        x = 0; rowHeight = 0; items = []
      }
      items.append((index, x))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    if !items.isEmpty { rows.append((items, y, x - spacing, rowHeight)) }
    return rows
  }
}
