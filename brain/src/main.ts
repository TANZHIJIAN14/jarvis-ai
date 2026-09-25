// Milestone 1: hands-free Jarvis. Say "Hey Jarvis", or click the orb, or press Enter here.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "./claude-session.ts";
import { HistoryStore, type SessionRecord } from "./history.ts";
import { config } from "./config.ts";
import { Jarvis, type UiEvent } from "./jarvis.ts";
import { KokoroVoice } from "./kokoro.ts";
import { DEFAULT_LISTENER_OPTIONS, Listener } from "./listener.ts";
import { MicStream } from "./mic-stream.ts";
import { claudeOneShot } from "./oneshot.ts";
import { toWav } from "./recorder.ts";
import { SessionManager } from "./sessions.ts";
import { Speaker } from "./speaker.ts";
import { Transcriber } from "./transcriber.ts";
import { UiServer } from "./ui-server.ts";
import { Vad } from "./vad.ts";
import { WakeWord } from "./wake-word.ts";

const UI_APP = fileURLToPath(new URL("../../native/bin/JarvisUI", import.meta.url));
const voiceRules = fileURLToPath(new URL("../voice-rules.md", import.meta.url));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const log = (s = "") => process.stdout.write(s + "\n");

for (const model of ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis.onnx", "silero_vad.onnx"]) {
  if (!existsSync(join(config.modelsDir, model))) {
    log(`Missing model ${model}. Run scripts/fetch-models.sh first.`);
    process.exit(1);
  }
}
mkdirSync(config.workspace, { recursive: true });

log(cyan("Jarvis") + dim(` · workspace ${config.workspace}`));
log(dim("Loading models... (the first start downloads the Kokoro voice, ~310 MB)"));
const transcriber = new Transcriber({
  model: config.whisperModel,
  language: config.language,
  port: config.whisperPort,
  vocabulary: config.vocabulary,
});
const [wakeWord, vad, kokoro] = await Promise.all([
  WakeWord.load(config.modelsDir),
  Vad.load(join(config.modelsDir, "silero_vad.onnx")),
  loadKokoro(),
  transcriber.start(),
]);
const speaker = kokoro
  ? new Speaker({ synthesize: (text) => kokoro.synthesize(text) })
  : new Speaker({ voice: config.voice, speed: config.voiceSpeed });
speaker.onError = (err) => log(dim(`  (voice error: ${err.message})`));
speaker.warm();

let lastLevelAt = 0;
const listener = new Listener(wakeWord, vad, {
  onWake: (score) => {
    log(dim(`  wake word (${score.toFixed(2)})`));
    jarvis.activate(true);
  },
  onUtterance: (pcm) => void jarvis.onUtterance(pcm),
  onNoSpeech: () => jarvis.onNoSpeech(),
  onBargeIn: () => {
    log(dim("  (you talked over Jarvis)"));
    saveWatchDebug();
    jarvis.onBargeIn();
  },
  onWatchEnd: (peakMs) => {
    if (config.echoCancel) log(dim(`  (talk-over check: most speech heard while Jarvis spoke was ${Math.round(peakMs)} ms; ${DEFAULT_LISTENER_OPTIONS.bargeInMs} ms interrupts)`));
    saveWatchDebug();
  },
  onWatchFrame: config.debugAudio ? (prob, frame) => {
    watchProbs.push(Number(prob.toFixed(3)));
    watchFrames.push(Int16Array.from(frame));
  } : undefined,
  onLevel: (value) => {
    // The orb only needs the level while listening, ~12 times a second.
    if (jarvis.state !== "listening" || Date.now() - lastLevelAt < 80) return;
    lastLevelAt = Date.now();
    ui.broadcast({ type: "level", value });
  },
}, { wakeThreshold: config.wakeThreshold });

const history = new HistoryStore(join(config.dataDir, "jarvis.sqlite"));
const sessionEvent = (s: SessionRecord): UiEvent => ({ type: "session", id: s.id, title: s.title, project: s.project });
const sessions = new SessionManager({
  history,
  newClaude: ({ cwd, resume }) =>
    new ClaudeSession({
      cwd,
      resume,
      model: config.model,
      permissionMode: config.permissionMode,
      appendSystemPromptFile: voiceRules,
    }),
  ask: claudeOneShot("haiku"),
  defaultCwd: config.workspace,
  projectsDir: config.projectsDir,
  onChange: (s) => {
    log(dim(`  [session: ${s.title ?? "untitled"} · ${s.project}]`));
    ui.broadcast(sessionEvent(s));
  },
});

const jarvis = new Jarvis({
  listener,
  transcriber,
  speaker,
  sessions,
  history,
  emit: (event) => {
    logEvent(event);
    ui.broadcast(event);
  },
  bargeIn: config.echoCancel, // switched off below if the mic falls back to plain capture
});

const token = randomBytes(16).toString("hex");
const ui = new UiServer({
  port: config.uiPort,
  token,
  snapshot: (): UiEvent[] => [
    { type: "state", state: jarvis.state, followUp: jarvis.followUp },
    ...(sessions.record ? [sessionEvent(sessions.record)] : []),
  ],
  onCommand: (command) => {
    if (command.type === "activate") jarvis.activate(false);
    else if (command.type === "stop") jarvis.stop();
    else if (command.type === "quit") shutdown();
  },
});
await ui.start();
jarvis.prepare();

let fedSamples = 0;
let doneSamples = 0;
const mic = new MicStream((samples) => {
  fedSamples += samples.length;
  void listener.feed(samples).then(() => (doneSamples += samples.length));
}, { echoCancel: config.echoCancel });
mic.onRestart = (reason) => log(dim(`  (${reason})`));

// JARVIS_DEBUG_AUDIO=1: every 2 s while Jarvis speaks, how much mic audio arrived and how far
// behind the listener is. Tells a stalled mic apart from a lagging brain.
if (config.debugAudio) {
  let lastFed = 0;
  setInterval(() => {
    const arrived = (fedSamples - lastFed) / 16_000;
    lastFed = fedSamples;
    if (jarvis.state !== "speaking") return;
    const behind = (fedSamples - doneSamples) / 16_000;
    log(dim(`  (audio health: ${arrived.toFixed(1)} s of mic audio in the last 2 s; listener ${behind.toFixed(1)} s behind; ${watchFrames.length} talk-over frames)`));
  }, 2000);
}
await mic.start();
jarvis.bargeIn = mic.echoCancelling; // without echo cancellation Jarvis would interrupt itself
const uiApp = launchUi();

log(dim(`Ready. Say "Hey Jarvis", click the orb, or press Enter here. Ctrl+C quits.`));
log(dim(mic.echoCancelling
  ? "Echo cancellation on: talk over Jarvis to interrupt it.\n"
  : "Echo cancellation off: interrupt with \"Hey Jarvis\", a click or Enter.\n"));
const keys = createInterface({ input: process.stdin });
keys.on("line", () => (jarvis.state === "idle" ? jarvis.activate(false) : jarvis.stop()));
keys.on("SIGINT", shutdown);
process.on("SIGINT", shutdown);

// The neural voice, unless JARVIS_TTS=apple; falls back to the system voice if it can't load.
async function loadKokoro(): Promise<KokoroVoice | undefined> {
  if (config.tts !== "kokoro") return undefined;
  try {
    return await KokoroVoice.load({
      voice: config.voice ?? "bm_george",
      speed: config.voiceSpeed,
      cacheDir: join(config.modelsDir, "huggingface"),
    });
  } catch (err) {
    log(dim(`Kokoro voice unavailable (${(err as Error).message}); using the system voice.`));
    return undefined;
  }
}

// JARVIS_DEBUG_AUDIO=1: what the mic heard during each reply, with the VAD score per 32 ms frame.
let watchProbs: number[] = [];
let watchFrames: Int16Array[] = [];
function saveWatchDebug(): void {
  if (!config.debugAudio || watchFrames.length === 0) return;
  const dir = join(tmpdir(), "jarvis-debug");
  mkdirSync(dir, { recursive: true });
  const name = join(dir, `talk-over-${Date.now()}`);
  const pcm = Buffer.alloc(watchFrames.length * 512 * 2);
  watchFrames.forEach((f, i) => f.forEach((s, j) => pcm.writeInt16LE(s, (i * 512 + j) * 2)));
  writeFileSync(`${name}.wav`, toWav(pcm));
  writeFileSync(`${name}.json`, JSON.stringify({ frameMs: 32, probs: watchProbs }));
  log(dim(`  (saved ${name}.wav)`));
  watchProbs = [];
  watchFrames = [];
}

function launchUi(): ChildProcess | undefined {
  if (!existsSync(UI_APP)) {
    log(dim("JarvisUI is not built (npm run build:native); running without the orb."));
    return undefined;
  }
  const app = spawn(UI_APP, ["--port", String(config.uiPort), "--token", token], { stdio: "ignore" });
  app.on("exit", (code) => {
    if (code !== 0 && code !== null) log(dim(`JarvisUI exited with code ${code}`));
  });
  return app;
}

function logEvent(event: UiEvent): void {
  switch (event.type) {
    case "state":
      log(dim(`  [${event.state}${event.followUp ? ", follow-up" : ""}]`));
      break;
    case "transcript":
      log(`${dim("You:")} ${event.text}`);
      break;
    case "reply_start":
      process.stdout.write(cyan("Jarvis: "));
      break;
    case "reply_delta":
      process.stdout.write(event.text);
      break;
    case "tool":
      log(dim(`\n  ⚙ ${event.name} ${event.detail}`));
      break;
    case "reply_done":
      log(event.error ? `\n${event.error}` : "");
      break;
    case "notice":
      log(dim(`  (${event.text})`));
      break;
  }
}

function shutdown(): void {
  log(dim("\nBye."));
  saveWatchDebug();
  mic.stop();
  jarvis.close();
  history.close();
  speaker.close();
  kokoro?.close();
  transcriber.stop();
  uiApp?.kill();
  ui.close();
  process.exit(0);
}
