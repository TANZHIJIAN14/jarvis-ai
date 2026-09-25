import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;

// Every setting can be overridden with a JARVIS_* environment variable.
export const config = {
  // Reuse the model OpenSuperWhisper already downloaded.
  whisperModel:
    env.JARVIS_WHISPER_MODEL ??
    join(
      homedir(),
      "Library/Application Support/ru.starmel.OpenSuperWhisper/whisper-models/ggml-large-v3-turbo.bin",
    ),
  whisperPort: Number(env.JARVIS_WHISPER_PORT ?? 8178),
  language: env.JARVIS_LANGUAGE ?? "en",
  // Names and terms Whisper should expect. Add your projects and jargon here.
  vocabulary:
    env.JARVIS_VOCABULARY ??
    "Hey Jarvis. Claude, Claude Code, jarvis-ai, file system, terminal, repo, GitHub, TypeScript, npm, API, brainstorm.",
  // Recordings with less speech than this are ignored instead of transcribed.
  minSpeechMs: Number(env.JARVIS_MIN_SPEECH_MS ?? 300),
  // Where "switch to the … project" looks for project folders.
  projectsDir: env.JARVIS_PROJECTS_DIR ?? join(homedir(), "Documents"),
  // Jarvis's own data: the session history database.
  dataDir: env.JARVIS_DATA_DIR ?? join(homedir(), "Library/Application Support/Jarvis"),
  // Folder Claude Code works in. Brainstorming lives here, away from real code.
  workspace: env.JARVIS_WORKSPACE ?? join(homedir(), "jarvis-workspace"),
  // Claude model alias; unset = the CLI's default.
  model: env.JARVIS_MODEL,
  permissionMode: env.JARVIS_PERMISSION_MODE ?? "acceptEdits",
  // "kokoro" (local neural voice) or "apple" (system voice).
  tts: env.JARVIS_TTS ?? "kokoro",
  // Kokoro voice (e.g. bm_george, bm_daniel, bm_lewis, bm_fable, am_michael) or,
  // with JARVIS_TTS=apple, a system voice name; unset = the default for that engine.
  voice: env.JARVIS_VOICE,
  // Speaking speed; 1.0 = normal.
  voiceSpeed: Number(env.JARVIS_VOICE_SPEED ?? 1.0),
  // Wake word and VAD models (scripts/fetch-models.sh).
  modelsDir: env.JARVIS_MODELS_DIR ?? fileURLToPath(new URL("../../models", import.meta.url)),
  // Score in 0..1 that counts as "Hey Jarvis". Raise it if Jarvis wakes by mistake.
  wakeThreshold: Number(env.JARVIS_WAKE_THRESHOLD ?? 0.5),
  // Apple's echo cancellation on the mic, so you can interrupt Jarvis by talking over it.
  // It also removes music and videos playing on this Mac from what Jarvis hears.
  echoCancel: (env.JARVIS_ECHO_CANCEL ?? "1") !== "0",
  // Saves what the mic hears while Jarvis speaks (plus VAD scores) for tuning talk-over.
  debugAudio: env.JARVIS_DEBUG_AUDIO === "1",
  // Local port the Jarvis UI connects to.
  uiPort: Number(env.JARVIS_UI_PORT ?? 8765),
};
