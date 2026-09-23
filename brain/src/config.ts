import { homedir } from "node:os";
import { join } from "node:path";

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
  // Folder Claude Code works in. Brainstorming lives here, away from real code.
  workspace: env.JARVIS_WORKSPACE ?? join(homedir(), "jarvis-workspace"),
  // Claude model alias; unset = the CLI's default.
  model: env.JARVIS_MODEL,
  permissionMode: env.JARVIS_PERMISSION_MODE ?? "acceptEdits",
  // Voice name or identifier; unset = best-quality installed voice for your language.
  voice: env.JARVIS_VOICE,
  // Speaking speed; 1.0 = the system's normal rate.
  voiceSpeed: Number(env.JARVIS_VOICE_SPEED ?? 1.2),
};
