// Milestone 1: hands-free Jarvis. Say "Hey Jarvis", or click the orb, or press Enter here.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "./claude-session.ts";
import { config } from "./config.ts";
import { Jarvis, type UiEvent } from "./jarvis.ts";
import { KokoroVoice } from "./kokoro.ts";
import { Listener } from "./listener.ts";
import { MicStream } from "./mic-stream.ts";
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
  onLevel: (value) => {
    // The orb only needs the level while listening, ~12 times a second.
    if (jarvis.state !== "listening" || Date.now() - lastLevelAt < 80) return;
    lastLevelAt = Date.now();
    ui.broadcast({ type: "level", value });
  },
}, { wakeThreshold: config.wakeThreshold });

const jarvis = new Jarvis({
  listener,
  transcriber,
  speaker,
  newSession: () =>
    new ClaudeSession({
      cwd: config.workspace,
      model: config.model,
      permissionMode: config.permissionMode,
      appendSystemPromptFile: voiceRules,
    }),
  emit: (event) => {
    logEvent(event);
    ui.broadcast(event);
  },
});

const token = randomBytes(16).toString("hex");
const ui = new UiServer({
  port: config.uiPort,
  token,
  snapshot: (): UiEvent[] => [{ type: "state", state: jarvis.state, followUp: jarvis.followUp }],
  onCommand: (command) => {
    if (command.type === "activate") jarvis.activate(false);
    else if (command.type === "stop") jarvis.stop();
    else if (command.type === "quit") shutdown();
  },
});
await ui.start();
jarvis.prepare();

const mic = new MicStream((samples) => void listener.feed(samples));
await mic.start();
const uiApp = launchUi();

log(dim(`Ready. Say "Hey Jarvis", click the orb, or press Enter here. Ctrl+C quits.\n`));
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
  mic.stop();
  jarvis.close();
  speaker.close();
  transcriber.stop();
  uiApp?.kill();
  ui.close();
  process.exit(0);
}
