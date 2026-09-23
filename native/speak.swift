// Long-lived text-to-speech helper. One process for the whole session, so there is no
// per-sentence startup: spawning `say` per sentence cost ~1.4 s of silence between sentences.
//
// stdin, one command per line:   say <text>   |   stop
// stdout, one event per line:    start (a sentence began playing)   |   idle (queue empty)
//
// Build: xcrun swiftc -O -swift-version 5 speak.swift -o bin/speak
// Options: --voice <name or identifier>  --speed <multiplier, 1.0 = normal>

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

// Only touched on the main queue.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
  let synthesizer = AVSpeechSynthesizer()
  let voice = pickVoice()
  let rate: Float
  // Utterances queued since the last stop. Callbacks for anything else are stale
  // (a cancelled sentence reports didCancel after the next one is already queued).
  var pending = Set<ObjectIdentifier>()

  override init() {
    let speed = Float(argument("--speed") ?? "") ?? 1.0
    rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * speed)
    super.init()
    synthesizer.delegate = self
    let name = voice.map { "\($0.name) (\($0.identifier))" } ?? "system default"
    FileHandle.standardError.write("speak: voice \(name)\n".data(using: .utf8)!)
  }

  func say(_ text: String) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    utterance.rate = rate
    utterance.preUtteranceDelay = 0
    utterance.postUtteranceDelay = 0
    pending.insert(ObjectIdentifier(utterance))
    synthesizer.speak(utterance)
  }

  func stop() {
    pending.removeAll()
    synthesizer.stopSpeaking(at: .immediate)
    emit("idle")
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    guard pending.contains(ObjectIdentifier(utterance)) else { return }
    emit("start")
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finished(utterance)
  }

  func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finished(utterance)
  }

  private func finished(_ utterance: AVSpeechUtterance) {
    guard pending.remove(ObjectIdentifier(utterance)) != nil else { return }
    if pending.isEmpty { emit("idle") }
  }
}

let speaker = Speaker()

// Read commands off the main thread; the synthesizer and its delegate live on main.
DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async {
      if line == "stop" {
        speaker.stop()
      } else if line.hasPrefix("say ") {
        speaker.say(String(line.dropFirst(4)))
      }
    }
  }
  exit(0)
}
dispatchMain()
