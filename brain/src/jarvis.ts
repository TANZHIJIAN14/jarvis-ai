import { spawn } from "node:child_process";
import type { ClaudeSession } from "./claude-session.ts";
import type { CaptureOptions, Listener } from "./listener.ts";
import { SentenceSplitter } from "./sentences.ts";
import type { Speaker } from "./speaker.ts";
import type { Transcriber } from "./transcriber.ts";

// The turn state machine: wake -> listen -> transcribe -> think -> speak -> follow-up.
// Every activation bumps `gen`; async work from an older generation drops its result,
// which is how "Hey Jarvis" or a click interrupts whatever Jarvis was doing.

export type JarvisState = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

// Brain -> UI messages. native/JarvisUI.swift decodes the same shapes.
export type UiEvent =
  | { type: "state"; state: JarvisState; followUp: boolean }
  | { type: "level"; value: number }
  | { type: "transcript"; text: string }
  | { type: "reply_start" }
  | { type: "reply_delta"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "reply_done"; error?: string }
  | { type: "notice"; text: string };

// UI -> brain.
export type UiCommand = { type: "activate" } | { type: "stop" } | { type: "quit" };

const WAKE_CAPTURE: CaptureOptions = { preRollMs: 1500, noSpeechTimeoutMs: 5000 };
const CLICK_CAPTURE: CaptureOptions = { preRollMs: 200, noSpeechTimeoutMs: 6000 };
const FOLLOW_UP_CAPTURE: CaptureOptions = { preRollMs: 300, noSpeechTimeoutMs: 8000 };
const SESSION_IDLE_MS = 10 * 60_000; // design doc: a wake-up within 10 min continues the session
const CHIME = "/System/Library/Sounds/Pop.aiff";

export type JarvisDeps = {
  listener: Listener;
  transcriber: Transcriber;
  speaker: Speaker;
  newSession: () => ClaudeSession;
  emit: (event: UiEvent) => void;
  chime?: () => void;
};

export class Jarvis {
  state: JarvisState = "idle";
  followUp = false;
  private deps: JarvisDeps;
  private gen = 0;
  private session: ClaudeSession | undefined;
  private lastTurnAt = 0;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(deps: JarvisDeps) {
    this.deps = deps;
  }

  // "Hey Jarvis" or a click on the orb: drop whatever is happening and listen.
  activate(byVoice: boolean): void {
    this.interruptReply();
    this.gen++;
    (this.deps.chime ?? chime)();
    this.listen(byVoice ? WAKE_CAPTURE : CLICK_CAPTURE, false);
  }

  stop(): void {
    this.interruptReply();
    this.gen++;
    this.deps.listener.stopCapture();
    this.setState("idle");
  }

  onNoSpeech(): void {
    if (!this.followUp) this.deps.emit({ type: "notice", text: "Didn't hear anything" });
    this.setState("idle");
  }

  async onUtterance(pcm: Int16Array): Promise<void> {
    const gen = this.gen;
    const wasFollowUp = this.followUp;
    this.setState("transcribing");
    let text: string;
    try {
      text = await this.deps.transcriber.transcribePcm(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    } catch (err) {
      if (gen === this.gen) this.fail(`Transcription failed: ${(err as Error).message}`);
      return;
    }
    if (gen !== this.gen) return;

    text = stripWakePhrase(text);
    if (!text) {
      // Just "Hey Jarvis", then a pause: keep listening for the actual request.
      if (wasFollowUp) this.setState("idle");
      else this.listen(CLICK_CAPTURE, false);
      return;
    }
    this.deps.emit({ type: "transcript", text });

    if (/^(new session|fresh start|start over)\b/i.test(text)) {
      this.resetSession();
      this.prepare();
      this.deps.speaker.say("Okay, starting fresh.");
      await this.deps.speaker.idle();
      if (gen === this.gen) this.listen(FOLLOW_UP_CAPTURE, true);
      return;
    }
    await this.reply(text, gen);
  }

  // Start Claude Code now so the first question doesn't wait for it.
  prepare(): void {
    this.currentSession().warm();
  }

  close(): void {
    this.session?.close();
  }

  private async reply(text: string, gen: number): Promise<void> {
    this.setState("thinking");
    await this.turn; // an interrupted turn needs a moment to wind down
    if (gen !== this.gen) return;

    const { speaker, emit } = this.deps;
    const session = this.currentSession();
    const splitter = new SentenceSplitter();
    speaker.onFirstAudio = () => {
      if (gen === this.gen) this.setState("speaking");
    };
    emit({ type: "reply_start" });

    const turn = session.ask(text, {
      onText: (delta) => {
        if (gen !== this.gen) return;
        emit({ type: "reply_delta", text: delta });
        for (const sentence of splitter.push(delta)) speaker.say(sentence);
      },
      onTool: (name, input) => {
        if (gen === this.gen) emit({ type: "tool", name, detail: toolDetail(input) });
      },
    });
    this.turn = turn;
    const result = await turn;
    this.lastTurnAt = Date.now();
    if (gen !== this.gen) return;

    for (const sentence of splitter.flush()) speaker.say(sentence);
    if (result.isError && !result.interrupted) {
      emit({ type: "reply_done", error: result.text });
      speaker.say(/auth|log ?in/i.test(result.text)
        ? "I can't reach Claude. Please log in to Claude Code again."
        : "Sorry, something went wrong.");
    } else {
      emit({ type: "reply_done" });
    }
    await speaker.idle();
    if (gen !== this.gen) return;
    if (result.interrupted) {
      this.setState("idle");
      session.warm(); // the interrupted process exits; have the next one ready
    } else {
      this.listen(FOLLOW_UP_CAPTURE, true); // answer back without saying "Hey Jarvis" again
    }
  }

  private listen(opts: CaptureOptions, followUp: boolean): void {
    this.followUp = followUp;
    this.deps.listener.startCapture(opts);
    this.setState("listening");
  }

  private interruptReply(): void {
    this.deps.speaker.stop();
    if (this.session?.busy) this.session.interrupt();
  }

  private currentSession(): ClaudeSession {
    if (this.session && Date.now() - this.lastTurnAt > SESSION_IDLE_MS) this.resetSession();
    this.session ??= this.deps.newSession();
    return this.session;
  }

  private resetSession(): void {
    this.session?.close();
    this.session = undefined;
  }

  private fail(message: string): void {
    this.deps.emit({ type: "notice", text: message });
    this.setState("idle");
  }

  private setState(state: JarvisState): void {
    if (state !== "listening") this.followUp = false;
    if (state === this.state && state !== "listening") return;
    this.state = state;
    this.deps.emit({ type: "state", state, followUp: this.followUp });
  }
}

// The transcript starts with the wake phrase when capture began with it (pre-roll).
export function stripWakePhrase(text: string): string {
  return text.replace(/^\W*(?:(?:hey|hi|hello|ok|okay)\W+)?(?:jarvis|jarvi|garvis|travis|jervis)\b\W*/i, "").trim();
}

function toolDetail(input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? "";
  return String(detail).split("\n")[0].slice(0, 80);
}

function chime(): void {
  spawn("afplay", ["-v", "0.4", CHIME], { stdio: "ignore" }).on("error", () => {});
}
