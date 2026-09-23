# jarvis-ai

A voice interface for Claude Code, inspired by Iron Man's Jarvis. Say "Hey Jarvis", talk, and your local Claude Code session does the work and answers out loud.

Design doc: https://claude.ai/code/artifact/a0884708-95f7-4ee1-a547-3071fb0e700b

## Status

Milestone 0 (loop spike): push-to-talk in the terminal → whisper.cpp → Claude Code → macOS `say`.

## Layout

| Path | What |
| --- | --- |
| `brain/src/claude-session.ts` | Long-lived `claude -p` stream-json session using your Claude subscription login; resumes after interrupts |
| `brain/src/transcriber.ts` | Keeps `whisper-server` running with OpenSuperWhisper's `large-v3-turbo` model |
| `brain/src/sentences.ts` | Splits streamed markdown into speakable sentences and drops code |
| `brain/src/speaker.ts` | Queues sentences to `native/speak`, with barge-in |
| `native/speak.swift` | Long-lived AVSpeechSynthesizer helper: no per-sentence startup delay |
| `brain/src/recorder.ts` | Records via `native/mic-capture` (AVAudioEngine), 16 kHz mono WAV, speech level check |
| `native/mic-capture.swift` | Swift helper that streams the default mic as 16 kHz PCM |
| `brain/src/spike.ts` | The milestone 0 loop |
| `brain/voice-rules.md` | System prompt addition that makes replies suitable for speech |

## Run the spike

Requirements: macOS on Apple Silicon, Xcode command line tools (Swift), Node 23+, whisper.cpp (`brew install whisper-cpp`), OpenSuperWhisper's `ggml-large-v3-turbo.bin` model, and a logged-in `claude` CLI.

```bash
cd brain && npm install && npm run spike
```

Press Enter to talk, then Enter to stop. You can also type a message. Press Enter while Jarvis is thinking or speaking to interrupt it. The first recording asks your terminal app for microphone access. Jarvis records from the input selected in System Settings → Sound → Input.

Settings are environment variables: `JARVIS_WORKSPACE` (default `~/jarvis-workspace`), `JARVIS_MODEL` (e.g. `sonnet`), `JARVIS_VOICE` (voice name; default = best installed voice for your language), `JARVIS_VOICE_SPEED` (default 1.2; 1.0 = normal), `JARVIS_PERMISSION_MODE` (default `acceptEdits`), `JARVIS_WHISPER_MODEL`, `JARVIS_VOCABULARY` (names and terms Whisper should expect; add your projects), `JARVIS_MIN_SPEECH_MS` (default 300).

## Test

```bash
cd brain && npm test && npm run typecheck
```
