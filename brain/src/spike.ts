// Milestone 0: push-to-talk -> whisper.cpp -> Claude Code -> spoken reply.
// Press Enter to talk and Enter again to stop; or type a message instead.
// Press Enter while Jarvis is thinking or speaking to interrupt.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "./claude-session.ts";
import { config } from "./config.ts";
import { Recorder } from "./recorder.ts";
import { SentenceSplitter } from "./sentences.ts";
import { Speaker } from "./speaker.ts";
import { Transcriber } from "./transcriber.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const log = (s = "") => process.stdout.write(s + "\n");

const lines = lineReader();
const voiceRules = join(dirname(fileURLToPath(import.meta.url)), "..", "voice-rules.md");
const wavFile = join(tmpdir(), "jarvis-utterance.wav");

mkdirSync(config.workspace, { recursive: true });
const transcriber = new Transcriber({
  model: config.whisperModel,
  language: config.language,
  port: config.whisperPort,
  vocabulary: config.vocabulary,
});
const recorder = new Recorder();
// One speaker for the whole session, so the voice stays loaded between turns.
const speaker = new Speaker({ voice: config.voice, speed: config.voiceSpeed });
const session = new ClaudeSession({
  cwd: config.workspace,
  model: config.model,
  permissionMode: config.permissionMode,
  appendSystemPromptFile: voiceRules,
});

process.on("SIGINT", shutdown);

log(cyan("Jarvis spike") + dim(` · workspace ${config.workspace}`));
log(dim("Loading speech model..."));
await transcriber.start();
log(dim("Ready. Enter = talk, or type a message. Ctrl+C quits.\n"));

while (true) {
  const typed = (await lines.next("› ")).trim();
  let utterance = typed;
  let tSpeechEnd = Date.now();
  let sttMs = 0;

  if (!typed) {
    try {
      const tOpen = Date.now();
      process.stdout.write(dim("opening mic... "));
      await recorder.start();
      // Only now is the mic live; speaking before this was what lost first words.
      await lines.next(cyan("● listening") + dim(` (mic ready in ${Date.now() - tOpen} ms; Enter to stop) `));
      tSpeechEnd = Date.now();
      const recording = await recorder.stop(wavFile);
      if (recording.speechMs < config.minSpeechMs) {
        log(dim(`(didn't hear any speech: ${recording.speechMs} ms above threshold, peak ${recording.peakDbfs} dBFS)\n`));
        continue;
      }
      utterance = await transcriber.transcribe(wavFile);
      sttMs = Date.now() - tSpeechEnd;
      log(dim(`  audio ${recording.durationMs} ms · speech ${recording.speechMs} ms · peak ${recording.peakDbfs} dBFS`));
    } catch (err) {
      log(`Recording failed: ${(err as Error).message}`);
      continue;
    }
    if (!utterance) {
      log(dim("(didn't catch that)\n"));
      continue;
    }
    log(`${dim("You:")} ${utterance}`);
  }

  await respond(utterance, tSpeechEnd, sttMs);
}

async function respond(utterance: string, tStart: number, sttMs: number): Promise<void> {
  const splitter = new SentenceSplitter();
  let firstTokenMs: number | undefined;
  let firstAudioMs: number | undefined;
  speaker.onFirstAudio = () => (firstAudioMs = Date.now() - tStart);

  process.stdout.write(cyan("Jarvis: "));
  const turn = session.ask(utterance, {
    onText(delta) {
      firstTokenMs ??= Date.now() - tStart;
      process.stdout.write(delta);
      for (const sentence of splitter.push(delta)) speaker.say(sentence);
    },
    onTool(name, input) {
      log(dim(`\n  ⚙ ${name} ${toolSummary(input)}`));
    },
  });

  // Enter while Claude thinks or Jarvis talks = barge-in.
  const bargeIn = lines.next("").then(() => {
    speaker.stop();
    session.interrupt();
    return true;
  });

  const result = await turn;
  for (const sentence of splitter.flush()) speaker.say(sentence);
  if (result.isError && !result.interrupted) {
    log(`\n${result.text}`);
    speaker.say(/auth|log ?in/i.test(result.text) ? "I can't reach Claude. Please log in to Claude Code again." : "Sorry, something went wrong.");
  }
  const interrupted = await Promise.race([speaker.idle().then(() => false), bargeIn]);
  if (!interrupted) lines.cancel();

  log();
  log(dim(`  stt ${sttMs} ms · first token ${firstTokenMs ?? "-"} ms · first audio ${firstAudioMs ?? "-"} ms` +
    (interrupted ? " · interrupted" : "")));
  log();
}

function toolSummary(input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? "";
  return String(detail).split("\n")[0].slice(0, 80);
}

// Awaitable lines from stdin. cancel() withdraws the pending next() so a
// barge-in listener doesn't swallow the user's next prompt.
function lineReader() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let waiting: ((line: string) => void) | undefined;
  rl.on("line", (line) => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(line);
  });
  rl.on("SIGINT", shutdown);
  return {
    next(prompt: string): Promise<string> {
      if (prompt) process.stdout.write(prompt);
      return new Promise((resolve) => (waiting = resolve));
    },
    cancel() {
      waiting = undefined;
    },
  };
}

function shutdown(): void {
  log(dim("\nBye."));
  session.close();
  speaker.close();
  transcriber.stop();
  process.exit(0);
}
