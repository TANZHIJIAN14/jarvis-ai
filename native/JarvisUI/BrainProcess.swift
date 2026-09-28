// Jarvis.app mode: the app starts the brain (Node) itself and keeps it running, instead of the
// brain starting the UI. Launched from a terminal with --port/--token, the UI is the brain's
// child as before and this isn't used.
//
// Contents/Resources/jarvis/ holds the brain (brain/src, node_modules), the Swift helpers
// (native/bin) and app.json, written by scripts/build-app.sh: where Node lives and the PATH
// that finds whisper-server and claude (apps started from Finder get a bare PATH).

import AppKit
import Darwin
import Foundation

final class BrainProcess {
  let port: String
  let token: String
  private let whisperPort: Int // and the next one up, for live words
  private let root: URL
  private var process: Process?
  private var quitting = false
  private var recentCrashes: [Date] = []
  var onGaveUp: ((String) -> Void)?

  // Nil outside an app bundle built by build-app.sh.
  init?() {
    guard let resources = Bundle.main.resourceURL?.appendingPathComponent("jarvis"),
          FileManager.default.fileExists(atPath: resources.appendingPathComponent("app.json").path) else { return nil }
    root = resources
    port = String(freePort(from: 8765))
    whisperPort = freePort(from: 8178, count: 2)
    token = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  }

  static var dataDir: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Jarvis")
  }

  static var logFile: URL { dataDir.appendingPathComponent("jarvis.log") }

  func start() {
    guard let data = try? Data(contentsOf: root.appendingPathComponent("app.json")),
          let app = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let node = app["node"], FileManager.default.isExecutableFile(atPath: node) else {
      onGaveUp?("Node wasn't found. Install it (brew install node), then rebuild Jarvis.app.")
      return
    }
    try? FileManager.default.createDirectory(at: Self.dataDir, withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: Self.logFile.path) {
      FileManager.default.createFile(atPath: Self.logFile.path, contents: nil)
    }
    let log = try? FileHandle(forWritingTo: Self.logFile)
    log?.seekToEndOfFile()
    log?.write("\n--- Jarvis started \(Date()) ---\n".data(using: .utf8)!)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", "src/main.ts"]
    process.currentDirectoryURL = root.appendingPathComponent("brain")
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = app["path"] ?? env["PATH"]
    env["JARVIS_APP"] = "1"
    env["JARVIS_UI_PORT"] = port
    env["JARVIS_UI_TOKEN"] = token
    env["JARVIS_WHISPER_PORT"] = String(whisperPort)
    env["JARVIS_MODELS_DIR"] = Self.dataDir.appendingPathComponent("models").path
    env["NO_COLOR"] = "1"
    process.environment = env
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = log
    process.standardError = log
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async { self?.exited() }
    }
    do {
      try process.run()
      self.process = process
    } catch {
      onGaveUp?("Jarvis couldn't start: \(error.localizedDescription)")
    }
  }

  // The app is quitting: let the brain shut down (it stops whisper-server and Claude), then make sure.
  func stop() {
    quitting = true
    guard let process, process.isRunning else { return }
    process.interrupt()
    let deadline = Date().addingTimeInterval(2)
    while process.isRunning && Date() < deadline { usleep(50_000) }
    if process.isRunning { process.terminate() }
  }

  // Crashed: start again, unless it keeps crashing (3 times in a minute).
  private func exited() {
    guard !quitting else { return }
    recentCrashes = recentCrashes.filter { $0.timeIntervalSinceNow > -60 } + [Date()]
    if recentCrashes.count >= 3 {
      onGaveUp?("Jarvis keeps stopping. The log may say why.")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.start() }
  }
}

// The first port from `from` (with `count - 1` more after it) that nothing is listening on.
private func freePort(from start: Int, count: Int = 1) -> Int {
  func free(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
    }
  }
  var port = start
  while !(0..<count).allSatisfy({ free(port + $0) }) { port += count }
  return port
}
