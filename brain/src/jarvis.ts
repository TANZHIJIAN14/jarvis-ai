import { spawn } from "node:child_process";
import { parseCommand } from "./commands.ts";
import type { HistoryStore } from "./history.ts";
import type { CaptureOptions, Listener } from "./listener.ts";
import { SentenceSplitter } from "./sentences.ts";
import type { SessionManager } from "./sessions.ts";
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
  | { type: "notice"; text: string }
  | { type: "session"; id: number; title: string | null; project: string };

// UI -> brain.
export type UiCommand = { type: "activate" } | { type: "stop" } | { type: "quit" };

const WAKE_CAPTURE: CaptureOptions = { preRollMs: 1500, noSpeechTimeoutMs: 5000 };
const CLICK_CAPTURE: CaptureOptions = { preRollMs: 200, noSpeechTimeoutMs: 6000 };
const FOLLOW_UP_CAPTURE: CaptureOptions = { preRollMs: 300, noSpeechTimeoutMs: 8000 };
// Talking over Jarvis: the words that triggered it are already in the pre-roll.
const BARGE_IN_CAPTURE: CaptureOptions = { preRollMs: 800, noSpeechTimeoutMs: 3000, speechStarted: true };
// An utterance made only of these (with at least one STOP_WORD) means "stop talking",
// not a question for Claude: "Stop, man. Stop.", "okay, that's enough", "hey Jarvis, wait".
const STOP_WORDS = new Set(["stop", "wait", "holdon", "nevermind", "cancel", "quiet", "shush", "hush", "shutup",
  "enough", "pause", "okay", "ok", "thanks", "thank"]);
const FILLER_WORDS = new Set(["man", "please", "hey", "jarvis", "just", "now", "that's", "thats", "it", "oh", "uh",
  "um", "right", "alright", "you", "dude", "sir", "a", "second", "moment", "minute", "talking", "there"]);

export function isStopRequest(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/\bnever mind\b/g, "nevermind")
    .replace(/\bhold on\b/g, "holdon")
    .replace(/\bshut up\b/g, "shutup")
    .replace(/[^a-z' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.length <= 10 && words.some((w) => STOP_WORDS.has(w))
    && words.every((w) => STOP_WORDS.has(w) || FILLER_WORDS.has(w));
}
const CHIME = "/System/Library/Sounds/Pop.aiff";

export type JarvisDeps = {
  listener: Listener;
  transcriber: Transcriber;
  speaker: Speaker;
  sessions: SessionManager;
  history: HistoryStore;
  emit: (event: UiEvent) => void;
  chime?: () => void;
  // Interrupt by talking over Jarvis. Needs echo cancellation, or Jarvis hears itself.
  bargeIn?: boolean;
};

export class Jarvis {
  state: JarvisState = "idle";
  followUp = false;
  private deps: JarvisDeps;
  private gen = 0;
  bargeIn: boolean;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(deps: JarvisDeps) {
    this.deps = deps;
    this.bargeIn = deps.bargeIn ?? false;
  }

  // "Hey Jarvis" or a click on the orb: drop whatever is happening and listen.
  activate(byVoice: boolean): void {
    this.interruptReply();
    this.gen++;
    (this.deps.chime ?? chime)();
    this.listen(byVoice ? WAKE_CAPTURE : CLICK_CAPTURE, false);
  }

  // The user started talking while Jarvis was speaking.
  onBargeIn(): void {
    if (!this.bargeIn || this.state !== "speaking") return;
    this.interruptReply();
    this.gen++;
    this.listen(BARGE_IN_CAPTURE, false);
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

    if (isStopRequest(text)) {
      this.setState("idle");
      return;
    }
    const { sessions, history } = this.deps;
    const command = parseCommand(text);
    switch (command.kind) {
      case "new":
        sessions.startNew(sessions.record?.cwd);
        return this.say("Okay, starting fresh.", gen);
      case "project": {
        const path = sessions.findProject(command.name);
        if (!path) return this.say(`I couldn't find a project called ${command.name}.`, gen);
        const record = sessions.startNew(path);
        return this.say(`Okay, working in ${spokenName(record.project)} now.`, gen);
      }
      case "resume": {
        const found = sessions.findSession(command.query);
        if (!found) break; // not a past conversation: a normal request ("continue the story")
        sessions.resume(found);
        return this.say(`Back to ${found.title ?? `our conversation from ${whenSpoken(found.lastActiveAt)}`}.`, gen);
      }
      case "list": {
        const recent = history.recent(4);
        if (recent.length === 0) return this.say("We haven't talked about anything yet.", gen);
        const items = recent.map((s) => `${s.title ?? spokenName(s.project)}, ${whenSpoken(s.lastActiveAt)}`);
        return this.say(`Recently: ${items.join("; ")}.`, gen);
      }
      case "recall": {
        const notes = history.searchTurns(command.query, 4);
        if (notes.length === 0) break; // Claude may still know from the current conversation
        return this.reply(text, gen, withNotes(text, notes));
      }
    }
    await this.reply(text, gen);
  }

  // Start Claude Code now so the first question doesn't wait for it.
  prepare(): void {
    this.deps.sessions.prepare();
  }

  close(): void {
    this.deps.sessions.close();
  }

  // A short spoken answer from Jarvis itself (no Claude), then the follow-up window.
  private async say(text: string, gen: number): Promise<void> {
    this.deps.speaker.say(text);
    await this.deps.speaker.idle();
    if (gen === this.gen) this.listen(FOLLOW_UP_CAPTURE, true);
  }

  // `prompt` is what Claude sees (the request, plus notes from history for a recall);
  // `text` is what the user said, which is what gets recorded.
  private async reply(text: string, gen: number, prompt = text): Promise<void> {
    this.setState("thinking");
    await this.turn; // an interrupted turn needs a moment to wind down
    if (gen !== this.gen) return;

    const { speaker, emit } = this.deps;
    const session = this.deps.sessions.forTurn();
    const splitter = new SentenceSplitter();
    let replyText = "";
    const tools: string[] = [];
    speaker.onFirstAudio = () => {
      if (gen === this.gen) this.setState("speaking");
    };
    emit({ type: "reply_start" });

    const turn = session.ask(prompt, {
      onText: (delta) => {
        replyText += delta;
        if (gen !== this.gen) return;
        emit({ type: "reply_delta", text: delta });
        for (const sentence of splitter.push(delta)) speaker.say(sentence);
      },
      onTool: (name, input) => {
        tools.push(`${name} ${toolDetail(input)}`.trim());
        if (gen === this.gen) emit({ type: "tool", name, detail: toolDetail(input) });
      },
    });
    this.turn = turn;
    const result = await turn;
    if (!result.isError || result.interrupted) {
      this.deps.sessions.recordTurn(text, replyText.trim(), tools, result.sessionId);
    }
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
    if (this.deps.sessions.claude?.busy) this.deps.sessions.claude.interrupt();
  }

  private fail(message: string): void {
    this.deps.emit({ type: "notice", text: message });
    this.setState("idle");
  }

  private setState(state: JarvisState): void {
    if (state !== "listening") this.followUp = false;
    if (state === this.state && state !== "listening") return;
    this.state = state;
    this.deps.listener.watchForSpeech(this.bargeIn && state === "speaking");
    this.deps.emit({ type: "state", state, followUp: this.followUp });
  }
}

// The transcript starts with the wake phrase when capture began with it (pre-roll).
export function stripWakePhrase(text: string): string {
  return text.replace(/^\W*(?:(?:hey|hi|hello|ok|okay)\W+)?(?:jarvis|jarvi|garvis|travis|jervis)\b\W*/i, "").trim();
}

// What Claude sees for "what did we decide about X": the question, plus the most relevant
// past turns from the history store.
function withNotes(question: string, notes: ReturnType<HistoryStore["searchTurns"]>): string {
  const lines = notes.map(({ turn, session }) =>
    `- ${new Date(turn.at).toDateString()}, "${session.title ?? session.project}":\n` +
      `  User: ${turn.user.slice(0, 300)}\n  Assistant: ${turn.reply.slice(0, 600)}`);
  return `${question}\n\n(Notes from our past conversations, most relevant first. Answer from these; say so if they don't cover it.)\n${lines.join("\n")}`;
}

// "jarvis-ai" -> "jarvis ai", for speech.
function spokenName(project: string): string {
  return project.replace(/[-_]+/g, " ");
}

export function whenSpoken(at: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return "earlier today";
  if (day(at) === day(now - 86_400_000)) return "yesterday";
  if (now - at < 6 * 86_400_000) return `on ${new Date(at).toLocaleDateString("en-US", { weekday: "long" })}`;
  return `on ${new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
}

function toolDetail(input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? "";
  return String(detail).split("\n")[0].slice(0, 80);
}

function chime(): void {
  spawn("afplay", ["-v", "0.4", CHIME], { stdio: "ignore" }).on("error", () => {});
}
