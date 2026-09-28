# jarvis-ai

A voice interface for Claude Code, inspired by Iron Man's Jarvis. Say "Hey Jarvis", talk, and your local Claude Code session does the work and answers out loud.

Design doc: https://claude.ai/code/artifact/a0884708-95f7-4ee1-a547-3071fb0e700b

## Status

All milestones in the design doc are built: hands-free voice turns, the Calm glass orb and panel, sessions and history, background tasks with spoken approvals, and the Agents, History and Settings windows with first-run setup. The milestone 0 push-to-talk spike is still available as `npm run spike`.

## Run

Requirements: macOS on Apple Silicon, Xcode command line tools (Swift), Node 23+, whisper.cpp (`brew install whisper-cpp`), OpenSuperWhisper's `ggml-large-v3-turbo.bin` model, and a logged-in `claude` CLI.

### As a Mac app

```bash
cd brain && npm install && cd .. && scripts/build-app.sh --install
```

This builds `Jarvis.app` into `/Applications`. Open it from Spotlight or Finder: it lives in the menu bar, asks macOS for the microphone itself, and starts and looks after the brain (restarting it if it crashes). "Open at login" in Settings adds it as a login item; the brain's output goes to `~/Library/Application Support/Jarvis/jarvis.log` (menu bar → Open Log). The app has its own copy of the brain, so rebuild it after pulling changes. It still uses Node, `whisper-server` and `claude` from where they're installed. It's signed for this Mac only, so macOS asks for the microphone again after each rebuild.

### From a terminal

```bash
cd brain && npm install && npm start
```

The first start builds the Swift helpers and downloads the wake word and voice activity models (about 6 MB) and a small Whisper model for live words (148 MB) into `models/`; the Kokoro voice (about 310 MB) downloads in the background while Jarvis speaks with the Apple voice. First-run setup walks through the microphone, the Claude sign-in, the models and the voice. Your terminal app needs microphone access; Jarvis records from the input selected in System Settings → Sound → Input.

- Say **"Hey Jarvis"** and your request in one breath, or pause after "Hey Jarvis" and then speak. Jarvis stops listening after 0.7 s of silence. Your words appear under the orb as you speak.
- **Push to talk**: hold **F5** while you speak (for noisy rooms); releasing it ends the request.
- After it answers, you have 8 seconds to reply without the wake word (the ring around the orb).
- Jarvis works from your home folder: Claude can read any of your files and run read-only commands freely. Before it edits a file or runs anything else, Jarvis asks out loud ("May I run the tests in jarvis-ai?") and shows the exact command with Allow / Deny buttons. Say yes or no; silence means no. Commands that can't be undone (`git push`, `rm -r`, `git reset --hard`, `sudo`, …) need a click on Allow. **Always allow** (or "yes, always") saves a rule for that command, or for edits, in that folder; rules are listed in Settings → Background tasks.
- **Agents window** (menu bar → Agents Window, or "Agents window" / "Details" in the panel): every background task with its request, activity, approvals and result. Start one without speaking (**New task…**, ⌘N, optionally in a project folder), send a note to a running task (it's interrupted and carries on with the note) or a follow-up to a finished one, **Stop** a task, or **Copy resume command** to continue it in the terminal. A finished task shows the files it changed and the diff. A fourth task waits until one of the three slots frees.
- **History window** (menu bar → History, ⌘Y): past conversations by day and project, a search over everything said, summaries with open items in amber, and **Continue with Jarvis** (your next "Hey Jarvis" goes to that conversation).
- **Settings** (menu bar → Settings…, ⌘,): voice with samples, speed, "call me sir", wake sensitivity, talk-over, push to talk, tasks at once, the model, open at login, Always allow rules, projects, 7-day recordings and Clear history. Saved in `~/Library/Application Support/Jarvis/settings.json`.
- When things go wrong: if Claude can't be reached (signed out, not installed, offline), the orb turns red with a low tone and offers **Try again** (asks the same question) and Open Terminal. A usage limit is an ordinary reply; the request waits as a background task until the limit resets. A failed background task is reported on your next wake with the failing line, and a red menu bar badge.
- Waking Jarvis mid-answer silences it right away; Claude's work stops only if you then ask something else, say "stop", or say nothing.
- Talk over Jarvis to interrupt it (about a third of a second of speech); "stop" or "never mind" just ends it. "Hey Jarvis", a click on the orb or Enter in the terminal also interrupt.
- Sessions: a wake-up within 10 minutes continues the conversation; later ones start fresh. Voice commands:
  - "new session" / "start over"
  - "go back to the Sepang trip": resumes the past conversation that mentions it (Claude remembers it)
  - "switch to the payments platform project": new session in that folder under `~/Documents`
  - "what did we decide about the voice?": answers from past conversations
  - "what have we been working on?" / "what's running?": lists background tasks and recent conversations
  - "keep going in the background" (say "Hey Jarvis" while Claude is working): the task carries on and your next request starts a fresh conversation. Up to three at once. When one finishes you hear a chime and the menu bar icon shows a green count; Jarvis tells you about it first on your next "Hey Jarvis" ("Quick update first: …").
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
| `brain/src/settings.ts`, `mac.ts` | Settings (saved, validated, environment-locked); open at login, Claude sign-in check, recordings |
| `brain/src/changes.ts`, `rules.ts` | Files a task changed and its diff; "Always allow" rules |
| `brain/src/errors.ts` | Sorts Claude failures into can't-reach (red Error), usage limit, or other |
| `brain/src/voices.ts` | The voice that follows Settings: Kokoro, or the Apple voice rendered with `say` |
| `brain/src/commands.ts` | Session voice commands ("go back to …", "switch to the … project", …) |
| `brain/src/claude-session.ts` | Long-lived `claude -p` stream-json session on your subscription login; pre-warmed; resumes after interrupts |
| `brain/src/transcriber.ts` | Keeps `whisper-server` running with OpenSuperWhisper's `large-v3-turbo` model |
| `brain/src/sentences.ts` | Splits streamed markdown into speakable sentences and drops code |
| `brain/src/kokoro.ts` | Kokoro-82M neural voice, rendered locally sentence by sentence |
| `brain/src/speaker.ts` | Synthesizes the next sentence while the current one plays; barge-in |
| `brain/src/approval-server.ts`, `approval-mcp.ts`, `approvals.ts` | Voice approvals: Claude Code's permission prompts → a spoken yes/no question |
| `brain/src/ui-server.ts` | Token-protected loopback WebSocket for the UI |
| `native/JarvisUI/` | Calm glass UI (SwiftUI): orb, conversation panel, approval, error and report cards, menu bar icon, the Agents, History, Settings and first-run windows, the F5 push-to-talk key |
| `native/JarvisUI/BrainProcess.swift` | Jarvis.app mode: starts the brain on free ports and restarts it if it crashes |
| `scripts/build-app.sh`, `make-icon.swift` | Builds and signs `Jarvis.app` with its icon |
| `brain/src/models.ts` | Downloads missing wake word, voice detection and live-words models on first start |
| `native/mic-capture.swift` | Streams the default mic as 16 kHz PCM (AVAudioEngine), with Apple's echo cancellation |
| `native/speak.swift` | Long-lived audio output helper: plays Kokoro audio or speaks with the system voice |
| `brain/voice-rules.md` | System prompt addition that makes replies suitable for speech |

Most settings live in the Settings window. Environment variables still work and win over it (the window shows those settings as locked): `JARVIS_WORKSPACE` (default: your home folder), `JARVIS_MODEL` (e.g. `sonnet`), `JARVIS_WAKE_THRESHOLD` (default 0.5; raise it if Jarvis wakes by mistake), `JARVIS_TTS` (`kokoro` default, or `apple` for the system voice), `JARVIS_VOICE` (Kokoro voice, default `bm_george`; also `bm_daniel`, `bm_lewis`, `bm_fable`, `am_michael`, ...; with `JARVIS_TTS=apple`, a system voice name), `JARVIS_VOICE_SPEED` (default 1.0 = normal; e.g. 0.9 slower, 1.1 faster), `JARVIS_PERMISSION_MODE` (default `manual`: ask before edits and commands), `JARVIS_VOCABULARY` (names and terms Whisper should expect), `JARVIS_ECHO_CANCEL` (default 1; 0 turns off Apple's echo cancellation, and with it talking over Jarvis), `JARVIS_UI_PORT` (default 8765), `JARVIS_PROJECTS_DIR` (default `~/Documents`), `JARVIS_DATA_DIR` (default `~/Library/Application Support/Jarvis`), `JARVIS_WHISPER_MODEL`, `JARVIS_PARTIALS_MS` (how often live words update, default 600; 0 turns them off).

## Test

```bash
cd brain && npm test && npm run typecheck
```
