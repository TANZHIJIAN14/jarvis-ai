// Claude's replies are markdown. SwiftUI's AttributedString only does inline markdown
// (bold, code, links), so tables came out as raw "| a | b |" lines. This splits a reply into
// blocks (paragraphs, headings, lists, code, tables) and renders each natively.
// Tolerant of streaming: a half-written table or code block renders as far as it has arrived.

import SwiftUI

enum MarkdownBlock: Equatable {
  case paragraph(String)
  case heading(String)
  case list(items: [String], ordered: Bool)
  case code(String)
  case table(header: [String]?, rows: [[String]], alignments: [TextAlignment])
}

func parseMarkdown(_ text: String) -> [MarkdownBlock] {
  var blocks: [MarkdownBlock] = []
  var paragraph: [String] = []
  let lines = text.components(separatedBy: "\n")
  var i = 0

  func flushParagraph() {
    let joined = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if !joined.isEmpty { blocks.append(.paragraph(joined)) }
    paragraph = []
  }

  while i < lines.count {
    let line = lines[i]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.hasPrefix("```") {
      flushParagraph()
      var code: [String] = []
      i += 1
      while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        code.append(lines[i])
        i += 1
      }
      blocks.append(.code(code.joined(separator: "\n")))
      i += 1
      continue
    }

    if trimmed.hasPrefix("|") {
      flushParagraph()
      var tableLines: [String] = []
      while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
        tableLines.append(lines[i].trimmingCharacters(in: .whitespaces))
        i += 1
      }
      blocks.append(parseTable(tableLines))
      continue
    }

    if let heading = trimmed.firstMatch(of: #/^#{1,6}\s+(.+)$/#) {
      flushParagraph()
      blocks.append(.heading(String(heading.1)))
      i += 1
      continue
    }

    if trimmed.firstMatch(of: #/^([-*+]|\d+[.)])\s+/#) != nil {
      flushParagraph()
      let ordered = trimmed.first?.isNumber ?? false
      var items: [String] = []
      while i < lines.count {
        let item = lines[i].trimmingCharacters(in: .whitespaces)
        guard let m = item.firstMatch(of: #/^(?:[-*+]|\d+[.)])\s+(.*)$/#) else { break }
        items.append(String(m.1))
        i += 1
      }
      blocks.append(.list(items: items, ordered: ordered))
      continue
    }

    if trimmed.isEmpty {
      flushParagraph()
    } else {
      paragraph.append(line)
    }
    i += 1
  }
  flushParagraph()
  return blocks
}

private func parseTable(_ lines: [String]) -> MarkdownBlock {
  func cells(_ line: String) -> [String] {
    var body = line
    if body.hasPrefix("|") { body.removeFirst() }
    if body.hasSuffix("|") { body.removeLast() }
    return body.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
  }
  func isSeparator(_ line: String) -> Bool {
    let parts = cells(line)
    return !parts.isEmpty && parts.allSatisfy { $0.firstMatch(of: #/^:?-{2,}:?$/#) != nil }
  }

  var rows = lines.map(cells)
  var header: [String]?
  var alignments: [TextAlignment] = []
  if lines.count >= 2, isSeparator(lines[1]) {
    header = rows[0]
    alignments = cells(lines[1]).map { spec in
      spec.hasPrefix(":") && spec.hasSuffix(":") ? .center : spec.hasSuffix(":") ? .trailing : .leading
    }
    rows = Array(rows.dropFirst(2))
  } else if let last = lines.last, isSeparator(last) {
    // Streaming: the separator has arrived but no rows yet.
    header = rows[0]
    rows = []
  }
  let columns = max(header?.count ?? 0, rows.map(\.count).max() ?? 0)
  rows = rows.map { $0 + Array(repeating: "", count: max(0, columns - $0.count)) }
  if alignments.count < columns { alignments += Array(repeating: .leading, count: columns - alignments.count) }
  return .table(header: header.map { $0 + Array(repeating: "", count: max(0, columns - $0.count)) }, rows: rows, alignments: alignments)
}

// MARK: - Views

struct MarkdownView: View {
  let text: String
  var fontSize: CGFloat = 15

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(parseMarkdown(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .paragraph(let text):
          Text(inline(text)).font(.system(size: fontSize)).lineSpacing(3)
        case .heading(let text):
          Text(inline(text)).font(.system(size: fontSize, weight: .semibold))
        case .list(let items, let ordered):
          VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordered ? "\(index + 1)." : "•").foregroundStyle(Theme.secondary).monospacedDigit()
                Text(inline(item))
              }
              .font(.system(size: fontSize))
            }
          }
        case .code(let code):
          ScrollView(.horizontal, showsIndicators: false) {
            Text(code).font(.system(size: 12, design: .monospaced)).lineSpacing(3).padding(10)
          }
          .background(Theme.text.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        case .table(let header, let rows, let alignments):
          TableView(header: header, rows: rows, alignments: alignments)
        }
      }
    }
    .textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// A markdown table as a quiet native grid: secondary header, hairline dividers, numbers that line up.
private struct TableView: View {
  let header: [String]?
  let rows: [[String]]
  let alignments: [TextAlignment]

  var body: some View {
    // Fits the panel when it can; only a table wider than the panel scrolls sideways.
    ViewThatFits(in: .horizontal) {
      grid
      ScrollView(.horizontal, showsIndicators: false) { grid }
    }
    .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.panelBorder, lineWidth: 1))
  }

  private var grid: some View {
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
        if let header {
          GridRow {
            ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
              Text(inline(cell))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.secondary)
                .gridColumnAlignment(horizontal(column))
                .padding(.bottom, 6)
            }
          }
          divider(columns: header.count)
        }
        ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
              Text(inline(cell))
                .font(.system(size: 13).monospacedDigit())
                .fixedSize(horizontal: false, vertical: true)
                .gridColumnAlignment(horizontal(column))
                .padding(.vertical, 6)
            }
          }
          if index < rows.count - 1 { divider(columns: row.count) }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
  }

  private func divider(columns: Int) -> some View {
    Rectangle().fill(Theme.panelBorder).frame(height: 1).gridCellColumns(max(columns, 1))
  }

  private func horizontal(_ column: Int) -> HorizontalAlignment {
    switch column < alignments.count ? alignments[column] : .leading {
    case .center: return .center
    case .trailing: return .trailing
    default: return .leading
    }
  }
}

// Bold, italics, `code` and links inside a line.
func inline(_ text: String) -> AttributedString {
  var result = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
    ?? AttributedString(text)
  for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
    result[run.range].font = .system(size: 13, design: .monospaced)
  }
  return result
}
