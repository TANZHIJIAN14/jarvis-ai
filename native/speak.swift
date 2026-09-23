// Long-lived audio output helper. One process for the whole session, so there is no
// per-sentence startup: spawning `say` per sentence cost ~1.4 s of silence between sentences.
// Speaks text with the system voice, or plays audio files (Kokoro's synthesized sentences),
// back to back from one queue.
//
// stdin, one command per line:   say <text>   |   play <wav path>   |   stop
// stdout, one event per line:    start (an item began playing)   |   idle (queue empty; once per stop)
//
// Build: xcrun swiftc -O -swift-version 5 speak.swift -o bin/speak
// Options: --voice <name or identifier>  --speed <multiplier, 1.0 = normal>
//          --delete-played (remove each file after playing it)

import AVFoundation
import Foundation

func argument(_ name: String) -> String? {
  guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[i + 1]
}

func emit(_ event: String) {
  FileHandle.standardOutput.write((event + "\n").data(using: .utf8)!)
}

// A named voice if asked for; otherwise the best-quality installed voice for the system language.
func pickVoice() -> AVSpeechSynthesisVoice? {
  let voices = AVSpeechSynthesisVoice.speechVoices()
  if let wanted = argument("--voice") {
    return voices.first { $0.identifier == wanted || $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
  }
  let language = AVSpeechSynthesisVoice.currentLanguageCode()
  return voices
    .filter { $0.language == language }
    .max { $0.quality.rawValue < $1.quality.rawValue }
}

enum Item {
  case speech(String)
  case file(URL)
}

// Only touched on the main queue.
final class Output: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate, @unchecked Sendable {
  let synthesizer = AVSpeechSynthesizer()
  let voice = pickVoice()
  let rate: Float
  let deletePlayed = CommandLine.arguments.contains("--delete-played")
  var queue: [Item] = []
  var current: AnyObject? // the utterance or player now playing; stale callbacks don't match it

  override init() {
    let speed = Float(argument("--speed") ?? "") ?? 1.0
    rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * speed)
    super.init()
    synthesizer.delegate = self
    let name = voice.map { "\($0.name) (\($0.identifier))" } ?? "system default"
    FileHandle.standardError.write("speak: system voice \(name)\n".data(using: .utf8)!)
    warmUp()
  }

  // The first playback wakes the audio device (~1 s). Do it now with 50 ms of silence,
  // so the first real sentence starts promptly.
  private var warmUpPlayer: AVAudioPlayer?
  private func warmUp() {
    var wav = Data("RIFF".utf8)
    let samples = 1200 // 50 ms at 24 kHz, 16-bit mono
    func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { wav.append(contentsOf: $0) } }
    func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { wav.append(contentsOf: $0) } }
    le32(UInt32(36 + samples * 2)); wav.append(contentsOf: Data("WAVEfmt ".utf8))
    le32(16); le16(1); le16(1); le32(24_000); le32(48_000); le16(2); le16(16)
    wav.append(contentsOf: Data("data".utf8)); le32(UInt32(samples * 2))
    wav.append(Data(count: samples * 2))
    warmUpPlayer = try? AVAudioPlayer(data: wav)
    warmUpPlayer?.volume = 0
    warmUpPlayer?.play()
  }

  func enqueue(_ item: Item) {
    queue.append(item)
    if current == nil { next() }
  }

  func stop() {
    for case .file(let url) in queue { discard(url) }
    queue.removeAll()
    let playing = current
    current = nil
    if let player = playing as? AVAudioPlayer {
      player.stop()
      discard(player.url)
    }
    synthesizer.stopSpeaking(at: .immediate)
    emit("idle")
  }

  private func next() {
    guard !queue.isEmpty else {
      current = nil
      emit("idle")
      return
    }
    switch queue.removeFirst() {
    case .speech(let text):
      let utterance = AVSpeechUtterance(string: text)
      utterance.voice = voice
      utterance.rate = rate
      utterance.preUtteranceDelay = 0
      utterance.postUtteranceDelay = 0
      current = utterance
      synthesizer.speak(utterance)
    case .file(let url):
      guard let player = try? AVAudioPlayer(contentsOf: url) else {
        discard(url)
        return next()
      }
      player.delegate = self
      current = player
      player.play()
      emit("start")
    }
  }

  private func finished(_ item: AnyObject) {
    guard item === current else { return }
    if let player = item as? AVAudioPlayer { discard(player.url) }
    next()
  }

  private func discard(_ url: URL?) {
    if deletePlayed, let url { try? FileManager.default.removeItem(at: url) }
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    if utterance === current { emit("start") }
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finished(utterance)
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finished(utterance)
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    finished(player)
  }
}

let output = Output()

// Read commands off the main thread; playback and its delegates live on main.
DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async {
      if line == "stop" {
        output.stop()
      } else if line.hasPrefix("say ") {
        output.enqueue(.speech(String(line.dropFirst(4))))
      } else if line.hasPrefix("play ") {
        output.enqueue(.file(URL(fileURLWithPath: String(line.dropFirst(5)))))
      }
    }
  }
  exit(0)
}
// A real run loop, not dispatchMain(): AVAudioPlayer delivers its finish callback through it.
RunLoop.main.run()
