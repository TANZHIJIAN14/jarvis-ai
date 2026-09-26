# jarvis-ai

A voice interface for Claude Code, inspired by Iron Man's Jarvis. Say "Hey Jarvis", talk, and your local Claude Code session does the work and answers out loud.

Design doc: https://claude.ai/code/artifact/a0884708-95f7-4ee1-a547-3071fb0e700b

## Status

Milestone 1 (hands-free): say "Hey Jarvis", speak, and hear the answer; a menu bar icon and a floating orb show what Jarvis is doing. The milestone 0 push-to-talk spike is still available as `npm run spike`.

## Run

Requirements: macOS on Apple Silicon, Xcode command line tools (Swift), Node 23+, whisper.cpp (`brew install whisper-cpp`), OpenSuperWhisper's `ggml-large-v3-turbo.bin` model, and a logged-in `claude` CLI.

```bash
cd brain && npm install && npm start
```

The first start builds the Swift helpers and downloads the wake word and voice activity models (about 6 MB) and the Kokoro voice (about 310 MB) into `models/`. Your terminal app needs microphone access; Jarvis records from the input selected in System Settings → Sound → Input.

- Say **"Hey Jarvis"** and your request in one breath, or pause after "Hey Jarvis" and then speak. Jarvis stops listening after 0.7 s of silence.
- After it answers, you have 8 seconds to reply without the wake word (the ring around the orb).
- Talk over Jarvis to interrupt it (about a third of a second of speech); "stop" or "never mind" just ends it. "Hey Jarvis", a click on the orb or Enter in the terminal also interrupt.
- Sessions: a wake-up within 10 minutes continues the conversation; later ones start fresh. Voice commands:
  - "new session" / "start over"
  - "go back to the Sepang trip": resumes the past conversation that mentions it (Claude remembers it)
  - "switch to the payments platform project": new session in that folder under `~/Documents`
  - "what did we decide about the voice?": answers from past conversations
  - "what have we been working on?": lists recent conversations
- Every turn is saved to `~/Library/Application Support/Jarvis/jarvis.sqlite`; conversations get a short title after the first turn and a summary when Jarvis moves on.

## Layout

| Path | What |
| --- | --- |
| `brain/src/main.ts` | Entry point: loads models, starts the mic, the UI server and the orb app |
| `brain/src/jarvis.ts` | Turn state machine: wake → listen → transcribe → think → speak → follow-up, with barge-in |
| `brain/src/listener.ts` | Mic stream → wake word, or VAD endpointing with pre-roll |
| `brain/src/wake-word.ts` | openWakeWord "hey jarvis" pipeline on ONNX Runtime |
| `brain/src/vad.ts` | Silero VAD v5 |
| `brain/src/sessions.ts` | Which conversation a request goes to: 10-minute rule, resume, projects; titles and summaries |
| `brain/src/history.ts` | Session and turn history (SQLite) with keyword search |
| `brain/src/commands.ts` | Session voice commands ("go back to …", "switch to the … project", …) |
| `brain/src/claude-session.ts` | Long-lived `claude -p` stream-json session on your subscription login; pre-warmed; resumes after interrupts |
| `brain/src/transcriber.ts` | Keeps `whisper-server` running with OpenSuperWhisper's `large-v3-turbo` model |
| `brain/src/sentences.ts` | Splits streamed markdown into speakable sentences and drops code |
| `brain/src/kokoro.ts` | Kokoro-82M neural voice, rendered locally sentence by sentence |
| `brain/src/speaker.ts` | Synthesizes the next sentence while the current one plays; barge-in |
| `brain/src/ui-server.ts` | Token-protected loopback WebSocket for the UI |
| `native/JarvisUI.swift` | Menu bar icon and floating orb + response panel (SwiftUI) |
| `native/mic-capture.swift` | Streams the default mic as 16 kHz PCM (AVAudioEngine), with Apple's echo cancellation |
| `native/speak.swift` | Long-lived audio output helper: plays Kokoro audio or speaks with the system voice |
| `brain/voice-rules.md` | System prompt addition that makes replies suitable for speech |

Settings are environment variables: `JARVIS_WORKSPACE` (default `~/jarvis-workspace`), `JARVIS_MODEL` (e.g. `sonnet`), `JARVIS_WAKE_THRESHOLD` (default 0.5; raise it if Jarvis wakes by mistake), `JARVIS_TTS` (`kokoro` default, or `apple` for the system voice), `JARVIS_VOICE` (Kokoro voice, default `bm_george`; also `bm_daniel`, `bm_lewis`, `bm_fable`, `am_michael`, ...; with `JARVIS_TTS=apple`, a system voice name), `JARVIS_VOICE_SPEED` (default 1.0 = normal; e.g. 0.9 slower, 1.1 faster), `JARVIS_PERMISSION_MODE` (default `acceptEdits`), `JARVIS_VOCABULARY` (names and terms Whisper should expect), `JARVIS_ECHO_CANCEL` (default 1; 0 turns off Apple's echo cancellation, and with it talking over Jarvis), `JARVIS_UI_PORT` (default 8765), `JARVIS_PROJECTS_DIR` (default `~/Documents`), `JARVIS_DATA_DIR` (default `~/Library/Application Support/Jarvis`), `JARVIS_WHISPER_MODEL`.

## Test

```bash
cd brain && npm test && npm run typecheck
```
