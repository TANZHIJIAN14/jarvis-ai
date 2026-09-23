// Streams the default microphone to stdout as 16 kHz mono 16-bit PCM, the format whisper.cpp wants.
// Uses AVAudioEngine, the same capture path as OpenSuperWhisper: ffmpeg's avfoundation input
// produced broadband noise on the MacBook's 96 kHz mic and wrecked transcription accuracy.
// Stops when stdin sends "q" or closes.
//
// Build: xcrun swiftc -O -swift-version 5 mic-capture.swift -o bin/mic-capture

import AVFoundation
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("mic-capture: \(message)\n".data(using: .utf8)!)
  exit(1)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let inputFormat = input.outputFormat(forBus: 0)
guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { fail("no input device") }
guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
  fail("cannot convert from \(inputFormat)")
}
converter.downmix = true

input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
  let ratio = outputFormat.sampleRate / inputFormat.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
  guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
  var supplied = false
  var error: NSError?
  converter.convert(to: converted, error: &error) { _, status in
    if supplied {
      status.pointee = .noDataNow
      return nil
    }
    supplied = true
    status.pointee = .haveData
    return buffer
  }
  if let error { fail("conversion failed: \(error.localizedDescription)") }
  guard converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
  FileHandle.standardOutput.write(Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
}

do {
  try engine.start()
} catch {
  fail("cannot start audio engine: \(error.localizedDescription)")
}

DispatchQueue.global().async {
  while let line = readLine(), line != "q" {}
  engine.stop()
  exit(0)
}
dispatchMain()
