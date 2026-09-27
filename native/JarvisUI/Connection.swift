// WebSocket client to the brain (brain/src/ui-server.ts): events in, commands out.

import Foundation

final class BrainConnection {
  private let url: URL
  private let model: JarvisModel
  private var task: URLSessionWebSocketTask?

  init(port: String, token: String, model: JarvisModel) {
    url = URL(string: "ws://127.0.0.1:\(port)/?token=\(token)")!
    self.model = model
  }

  func connect() {
    let task = URLSession.shared.webSocketTask(with: url)
    self.task = task
    task.resume()
    receive(task)
  }

  // UiCommand in brain/src/jarvis.ts.
  func send(_ command: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: command),
          let text = String(data: data, encoding: .utf8) else { return }
    task?.send(.string(text)) { _ in }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        if case .string(let text) = message,
           let data = text.data(using: .utf8),
           let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          DispatchQueue.main.async {
            self.model.connected = true
            self.model.apply(event)
          }
        }
        self.receive(task)
      case .failure:
        DispatchQueue.main.async { self.model.connected = false }
        // The brain may still be starting, or restarting: retry.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.connect() }
      }
    }
  }
}
