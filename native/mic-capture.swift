// Streams the default microphone to stdout as 16 kHz mono 16-bit PCM, the format whisper.cpp wants.
// Uses AVAudioEngine, the same capture path as OpenSuperWhisper: ffmpeg's avfoundation input
// produced broadband noise on the MacBook's 96 kHz mic and wrecked transcription accuracy.
// Stops when stdin sends "q" or closes.
//
// --echo-cancel turns on Apple's voice processing. On macOS it removes everything the Mac itself
// is playing (Jarvis's voice from any process, but also music and videos) from the mic signal,
// so the user can talk over Jarvis. Measured with a Kokoro clip on the MacBook speakers: VAD
// speech in 0% of frames with it on, 68-83% without.
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
if CommandLine.arguments.contains("--echo-cancel") {
  // Voice processing couples input and output into one I/O unit; the output side has to
  // exist before it is switched on, or engine.start() fails with -10875.
  _ = engine.mainMixerNode
  _ = engine.outputNode
  do {
    try input.setVoiceProcessingEnabled(true)
  } catch {
    fail("cannot enable echo cancellation: \(error.localizedDescription)")
  }
  // Voice processing ducks other apps' audio by default (music gets quiet); keep that minimal.
  input.voiceProcessingOtherAudioDuckingConfiguration =
    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
}

let inputFormat = input.outputFormat(forBus: 0)
guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { fail("no input device") }
// With voice processing the MacBook mic reports 7 identical channels at 96 kHz, and
// AVAudioConverter's downmix of them yields silence. Take channel 0 and convert that.
guard let monoFormat = AVAudioFormat(standardFormatWithSampleRate: inputFormat.sampleRate, channels: 1),
      let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: monoFormat, to: outputFormat) else {
  fail("cannot convert from \(inputFormat)")
}

// Writes happen off the audio thread: if the reader stalls and the pipe fills, a blocked
// write inside the tap would stall the (echo-cancelling) input unit itself.
let writer = DispatchQueue(label: "mic-capture.stdout")

input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { tapped, _ in
  guard let source = tapped.floatChannelData,
        let buffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: tapped.frameLength) else { return }
  buffer.frameLength = tapped.frameLength
  buffer.floatChannelData![0].update(from: source[0], count: Int(tapped.frameLength))

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
  let data = Data(bytes: samples[0], count: Int(converted.frameLength) * 2)
  writer.async { FileHandle.standardOutput.write(data) }
}

engine.prepare()
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
