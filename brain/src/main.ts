// Milestone 1: hands-free Jarvis. Say "Hey Jarvis", or click the orb, or press Enter here.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ApprovalServer, type ApprovalDecision } from "./approval-server.ts";
import { ClaudeSession } from "./claude-session.ts";
import { HistoryStore, type SessionRecord } from "./history.ts";
import { config } from "./config.ts";
import { Jarvis, type UiEvent } from "./jarvis.ts";
import { KokoroVoice } from "./kokoro.ts";
import { DEFAULT_LISTENER_OPTIONS, Listener } from "./listener.ts";
import { MicStream } from "./mic-stream.ts";
import { claudeOneShot } from "./oneshot.ts";
import { clearRecordings, claudeStatus, isOpenAtLogin, pruneRecordings, saveRecording, setOpenAtLogin } from "./mac.ts";
import { SettingsStore, VOICES, type Settings } from "./settings.ts";
import { voiceSynth } from "./voices.ts";
import { toWav } from "./recorder.ts";
import { SessionManager } from "./sessions.ts";
import { Speaker } from "./speaker.ts";
import { Transcriber } from "./transcriber.ts";
import { AllowRules } from "./rules.ts";
import { UiServer } from "./ui-server.ts";
import { Vad } from "./vad.ts";
import { WakeWord } from "./wake-word.ts";

const UI_APP = fileURLToPath(new URL("../../native/bin/JarvisUI", import.meta.url));
const voiceRules = fileURLToPath(new URL("../voice-rules.md", import.meta.url));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const log = (s = "") => process.stdout.write(s + "\n");

// Settings (the Settings window) start from config.ts, where JARVIS_* variables win.
const settings = new SettingsStore(join(config.dataDir, "settings.json"), {
  voice: config.tts === "apple" ? (config.voice ?? "samantha") : (config.voice ?? "bm_george"),
  voiceSpeed: config.voiceSpeed,
  sir: false,
  wakeThreshold: config.wakeThreshold,
  talkOver: config.echoCancel,
  pushToTalk: true,
  maxTasks: 3,
  model: config.model ?? "",
  openAtLogin: isOpenAtLogin(),
  keepRecordings: false,
  projects: [],
  onboarded: existsSync(join(config.dataDir, "jarvis.sqlite")), // set up before Settings existed
});
// Events from before the UI server starts (model download progress) are dropped.
let uiServer: UiServer | undefined;
const broadcast = (event: UiEvent) => uiServer?.broadcast(event);
const recordingsDir = join(config.dataDir, "recordings");
pruneRecordings(recordingsDir);
// Claude's voice rules, plus "call me sir" when that's on. Read by each new Claude process.
const rulesFile = join(config.dataDir, "voice-rules.md");
function writeVoiceRules(): void {
  mkdirSync(config.dataDir, { recursive: true });
  const sir = settings.values.sir ? '\n- Address the user as "sir" now and then, the way a butler would.\n' : "";
  writeFileSync(rulesFile, readFileSync(voiceRules, "utf8") + sir);
}
writeVoiceRules();

for (const model of ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis.onnx", "silero_vad.onnx"]) {
  if (!existsSync(join(config.modelsDir, model))) {
    log(`Missing model ${model}. Run scripts/fetch-models.sh first.`);
    process.exit(1);
  }
}
mkdirSync(config.workspace, { recursive: true });

log(cyan("Jarvis") + dim(` · workspace ${config.workspace}`));
log(dim("Loading models..."));
const transcriber = new Transcriber({
  model: config.whisperModel,
  language: config.language,
  port: config.whisperPort,
  vocabulary: config.vocabulary,
});
// Quitting while the models still load (or a crash) must not leave the Whisper servers running.
process.on("exit", () => {
  transcriber.stop();
  partialTranscriber?.stop();
});
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));

// Live words while you speak, from a small model; Jarvis works without it.
const partialModel = join(config.modelsDir, "ggml-base.en.bin");
const partialTranscriber = config.partialsMs > 0 && existsSync(partialModel)
  ? new Transcriber({ model: partialModel, language: config.language, port: config.whisperPort + 1, vocabulary: config.vocabulary, beam: false })
  : undefined;
const [wakeWord, vad, partialsReady] = await Promise.all([
  WakeWord.load(config.modelsDir),
  Vad.load(join(config.modelsDir, "silero_vad.onnx")),
  partialTranscriber?.start().then(() => true, (err: Error) => {
    log(dim(`Live words unavailable (${err.message}).`));
    return false;
  }),
  transcriber.start(),
]);
// The Kokoro voice loads in the background (the first start downloads ~310 MB); until it's
// ready, Jarvis speaks with the Apple voice.
let kokoro: KokoroVoice | undefined;
let kokoroProgress = { loaded: 0, total: 0, done: false, failed: false };
void loadKokoro();
const voice = voiceSynth(() => settings.values, () => kokoro);
const speaker = new Speaker({ synthesize: voice.synthesize });
speaker.onError = (err) => log(dim(`  (voice error: ${err.message})`));
speaker.warm();

let lastLevelAt = 0;
const listener = new Listener(wakeWord, vad, {
  onWake: (score) => {
    log(dim(`  wake word (${score.toFixed(2)})`));
    jarvis.activate(true);
  },
  onUtterance: (pcm) => {
    if (settings.values.keepRecordings) saveRecording(recordingsDir, pcm);
    void jarvis.onUtterance(pcm);
  },
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
}, { wakeThreshold: settings.values.wakeThreshold });

const history = new HistoryStore(join(config.dataDir, "jarvis.sqlite"));
// Claude asks here before edits and commands; Jarvis asks the user.
const approvals = new ApprovalServer((request): Promise<ApprovalDecision> => jarvis.requestApproval(request));
await approvals.start();
const sessionEvent = (s: SessionRecord): UiEvent => ({ type: "session", id: s.id, title: s.title, project: s.project });
const sessions = new SessionManager({
  history,
  newClaude: ({ cwd, resume, sessionId }) =>
    new ClaudeSession({
      cwd,
      resume,
      model: settings.values.model || undefined,
      permissionMode: config.permissionMode,
      appendSystemPromptFile: rulesFile,
      mcpConfig: approvals.mcpConfig(sessionId),
      permissionPromptTool: "mcp__jarvis__approve",
    }),
  ask: claudeOneShot("haiku"),
  defaultCwd: config.workspace,
  projectsDir: config.projectsDir,
  extraProjects: () => settings.values.projects,
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
  rules: new AllowRules(join(config.dataDir, "always-allow.json")),
  partialTranscriber: partialsReady ? partialTranscriber : undefined,
  partialsMs: config.partialsMs,
});

const token = randomBytes(16).toString("hex");
const ui = new UiServer({
  port: config.uiPort,
  token,
  snapshot: (): UiEvent[] => [
    { type: "state", state: jarvis.state, followUp: jarvis.followUp },
    ...(sessions.record ? [sessionEvent(sessions.record)] : []),
    jarvis.rulesEvent(),
    settingsEvent(),
    modelsEvent(),
  ],
  onCommand: (command) => {
    if (command.type === "activate") jarvis.activate(false);
    else if (command.type === "stop") jarvis.stop();
    else if (command.type === "quit") shutdown();
    else if (command.type === "approve") jarvis.answerFromUi(command.id, command.allow, command.always);
    else if (command.type === "rule_remove") jarvis.removeRule(command.index);
    else if (command.type === "retry") jarvis.retry();
    else if (command.type === "ptt") {
      if (settings.values.pushToTalk) jarvis.pushToTalk(command.down);
    } else if (command.type === "settings_set") changeSettings(command.values);
    else if (command.type === "voice_sample") {
      speaker.stop();
      speaker.say("Good morning. I'm ready when you are.", voice.sample(command.voice));
    } else if (command.type === "claude_check") void checkClaude();
    else if (command.type === "mic_check") ui.broadcast(micEvent());
    else if (command.type === "history_clear") {
      history.clear();
      clearRecordings(recordingsDir);
      sessions.startNew();
      jarvis.historyQuery("");
      ui.broadcast({ type: "notice", text: "History cleared." });
    }
    else if (command.type === "report_seen") jarvis.reportSeen(command.taskId);
    else if (command.type === "task_new") jarvis.startTask(command.text, command.project);
    else if (command.type === "task_note") jarvis.noteTask(command.taskId, command.text);
    else if (command.type === "task_stop") jarvis.stopTask(command.taskId);
    else if (command.type === "history_query") jarvis.historyQuery(command.query, command.project);
    else if (command.type === "history_open") jarvis.historyOpen(command.id);
    else if (command.type === "history_continue") jarvis.historyContinue(command.id);
  },
});
await ui.start();
uiServer = ui;
jarvis.prepare();
sessions.maxBackground = settings.values.maxTasks;
void checkClaude();

let fedSamples = 0;
let doneSamples = 0;
// Microphone access, for first-run setup: any non-silent audio means macOS lets Jarvis hear.
let heardAudio = false;
const mic = new MicStream((samples) => {
  fedSamples += samples.length;
  if (!heardAudio && samples.some((s) => s !== 0)) {
    heardAudio = true;
    ui.broadcast(micEvent());
  }
  void listener.feed(samples).then(() => (doneSamples += samples.length));
}, { echoCancel: settings.values.talkOver });
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
jarvis.bargeIn = settings.values.talkOver && mic.echoCancelling; // without echo cancellation Jarvis would interrupt itself
const uiApp = launchUi();

log(dim(`Ready. Say "Hey Jarvis", click the orb, or press Enter here. Ctrl+C quits.`));
log(dim(mic.echoCancelling
  ? "Echo cancellation on: talk over Jarvis to interrupt it.\n"
  : "Echo cancellation off: interrupt with \"Hey Jarvis\", a click or Enter.\n"));
const keys = createInterface({ input: process.stdin });
keys.on("line", () => (jarvis.state === "idle" ? jarvis.activate(false) : jarvis.stop()));
keys.on("SIGINT", shutdown);
process.removeAllListeners("SIGINT");
process.on("SIGINT", shutdown);
process.removeAllListeners("SIGTERM");
process.on("SIGTERM", shutdown);

// The neural voice; until it loads (or if it can't), the Apple voice speaks.
async function loadKokoro(): Promise<void> {
  try {
    kokoro = await KokoroVoice.load({ voice: "bm_george", speed: 1, cacheDir: join(config.modelsDir, "huggingface") },
      (loaded, total) => {
        kokoroProgress = { ...kokoroProgress, loaded, total };
        broadcast(modelsEvent());
      });
    kokoroProgress = { ...kokoroProgress, done: true };
  } catch (err) {
    kokoroProgress = { ...kokoroProgress, failed: true };
    log(dim(`Kokoro voice unavailable (${(err as Error).message}); using the system voice.`));
  }
  broadcast(modelsEvent());
}

// --- Settings ---

function settingsEvent(): UiEvent {
  const known = new Map<string, string>([[config.workspace, "default"]]);
  for (const path of settings.values.projects) known.set(path, "added");
  for (const s of history.recent(30)) if (!known.has(s.cwd)) known.set(s.cwd, "recent");
  return {
    type: "settings",
    values: settings.values,
    locked: settings.locked,
    voices: VOICES,
    projects: [...known].slice(0, 12).map(([path, kind]) => ({ path, kind })),
    permissionMode: config.permissionMode,
    dataDir: config.dataDir,
  };
}

function changeSettings(patch: Partial<Settings>): void {
  const changed = settings.update(patch);
  const v = settings.values;
  for (const key of changed) {
    if (key === "wakeThreshold") listener.setWakeThreshold(v.wakeThreshold);
    if (key === "maxTasks") sessions.maxBackground = v.maxTasks;
    if (key === "sir") writeVoiceRules();
    if (key === "talkOver") jarvis.bargeIn = v.talkOver && mic.echoCancelling;
    if (key === "keepRecordings" && !v.keepRecordings) clearRecordings(recordingsDir);
    if (key === "openAtLogin") {
      setOpenAtLogin(v.openAtLogin, {
        args: [process.execPath, "--experimental-strip-types", "--no-warnings=ExperimentalWarning", fileURLToPath(import.meta.url)],
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        log: join(config.dataDir, "jarvis.log"),
      });
    }
  }
  if (changed.some((k) => k === "model" || k === "sir")) {
    // New Claude processes pick these up; start the next conversation with them.
    if (!sessions.claude?.busy) sessions.startNew(sessions.record?.cwd);
  }
  ui.broadcast(settingsEvent());
}

async function checkClaude(): Promise<void> {
  ui.broadcast({ type: "claude_status", ...(await claudeStatus()) });
}

// First-run setup: the models, and whether macOS lets Jarvis hear the mic.
function modelsEvent(): UiEvent {
  return {
    type: "models",
    whisper: existsSync(config.whisperModel),
    kokoro: kokoroProgress,
  };
}

function micEvent(): UiEvent {
  return { type: "mic_status", ok: heardAudio };
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
    case "approval":
      log(`${cyan("Jarvis asks:")} ${event.question}${event.detail ? dim(`  [${event.detail}]`) : ""}${event.destructive ? dim(" (needs a click)") : ""}`);
      break;
    case "task":
      log(dim(`  [task ${event.id}: ${event.title} · ${event.status}${event.activity ? ` · ${event.activity}` : ""}]`));
      break;
    case "error":
      log(`${cyan("Jarvis:")} ${event.text}`);
      break;
    case "approval_done":
      log(dim(`  (${event.allowed ? "approved" : "not approved"})`));
      break;
  }
}

function shutdown(): void {
  log(dim("\nBye."));
  saveWatchDebug();
  mic.stop();
  jarvis.close();
  history.close();
  approvals.close();
  speaker.close();
  kokoro?.close();
  transcriber.stop();
  partialTranscriber?.stop();
  uiApp?.kill();
  ui.close();
  process.exit(0);
}
