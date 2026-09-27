import { spawn } from "node:child_process";
import type { ApprovalDecision, ApprovalRequest } from "./approval-server.ts";
import { describeActivity } from "./activity.ts";
import { describeRequest, isDestructive, parseAnswer } from "./approvals.ts";
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

export type JarvisState = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "asking";

// Brain -> UI messages. native/JarvisUI.swift decodes the same shapes.
export type UiEvent =
  | { type: "state"; state: JarvisState; followUp: boolean }
  | { type: "level"; value: number }
  | { type: "transcript"; text: string }
  | { type: "reply_start" }
  | { type: "reply_delta"; text: string }
  | { type: "tool"; name: string; detail: string; activity: string }
  | { type: "reply_done"; error?: string }
  | { type: "notice"; text: string }
  | { type: "session"; id: number; title: string | null; project: string }
  | { type: "approval"; id: number; question: string; detail: string; destructive: boolean; taskId?: number }
  | { type: "approval_done"; id: number; allowed: boolean }
  // A background task (its id is its session's id). `reported`: its result has been told to the user.
  | { type: "task"; id: number; title: string; project: string; status: TaskStatus; activity: string;
      startedAt: number; reported: boolean }
  | { type: "task_report"; taskId: number; title: string; summary: string };

export type TaskStatus = "running" | "done" | "failed" | "stopped";

// UI -> brain.
export type UiCommand =
  | { type: "activate" }
  | { type: "stop" }
  | { type: "quit" }
  | { type: "approve"; id: number; allow: boolean }
  | { type: "report_seen"; taskId: number };

const WAKE_CAPTURE: CaptureOptions = { preRollMs: 1500, noSpeechTimeoutMs: 5000 };
const CLICK_CAPTURE: CaptureOptions = { preRollMs: 200, noSpeechTimeoutMs: 6000 };
const FOLLOW_UP_CAPTURE: CaptureOptions = { preRollMs: 300, noSpeechTimeoutMs: 8000 };
const ANSWER_CAPTURE: CaptureOptions = { preRollMs: 300, noSpeechTimeoutMs: 10_000 };
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

export type JarvisDeps = {
  listener: Listener;
  transcriber: Transcriber;
  speaker: Speaker;
  sessions: SessionManager;
  history: HistoryStore;
  emit: (event: UiEvent) => void;
  // "wake": Jarvis is listening; "done": a background task finished (its report waits for the next wake).
  sound?: (name: "wake" | "done") => void;

  // Interrupt by talking over Jarvis. Needs echo cancellation, or Jarvis hears itself.
  bargeIn?: boolean;
};

type Approval = {
  id: number;
  request: ApprovalRequest;
  question: string;
  detail: string;
  destructive: boolean; // needs a click, not a spoken yes
  taskId?: number;
  retries: number;
  resolve: (decision: ApprovalDecision) => void;
};

export class Jarvis {
  state: JarvisState = "idle";
  followUp = false;
  private deps: JarvisDeps;
  private gen = 0;
  bargeIn: boolean;
  private turn: Promise<unknown> = Promise.resolve();
  // Waking Jarvis mid-task silences it at once, but Claude keeps working until we know what
  // the user wants: "keep going in the background" must not kill the task.
  private interruptPending = false;
  // Background tasks, and finished ones not yet told to the user (spoken first on the next wake).
  private tasks = new Map<number, Extract<UiEvent, { type: "task" }>>();
  private unreported: Array<{ taskId: number; text: string }> = [];
  private lastActivity = ""; // the current turn's latest "what Jarvis is doing", carried into a handoff
  // Claude asking permission (edits, commands): one question at a time, answered by voice or on the orb.
  private approvals: Array<Approval> = [];
  private asking: Approval | undefined;
  private nextApprovalId = 1;

  constructor(deps: JarvisDeps) {
    this.deps = deps;
    this.bargeIn = deps.bargeIn ?? false;
  }

  // "Hey Jarvis" or a click on the orb: stop talking and listen.
  activate(byVoice: boolean): void {
    this.holdReply();
    const gen = ++this.gen;
    this.sound("wake");
    if (this.unreported.length > 0 && !this.asking) {
      void this.reportThenListen(gen);
      return;
    }
    this.listen(byVoice ? WAKE_CAPTURE : CLICK_CAPTURE, false);
  }

  // Finished background work is told first on the next wake: "Quick update first: …".
  private async reportThenListen(gen: number): Promise<void> {
    const reports = this.unreported.splice(0);
    for (const { taskId } of reports) this.markReported(taskId);
    const { speaker } = this.deps;
    speaker.onFirstAudio = () => {
      if (gen === this.gen) this.setState("speaking");
    };
    speaker.say(`Quick update first: ${reports.map((r) => r.text).join(" ")}`);
    speaker.say("What did you want to ask?");
    await speaker.idle();
    if (gen === this.gen) this.listen(CLICK_CAPTURE, false);
  }

  // The user saw a task's report on screen (Agents window, report card).
  reportSeen(taskId: number): void {
    this.unreported = this.unreported.filter((r) => r.taskId !== taskId);
    this.markReported(taskId);
  }

  private markReported(taskId: number): void {
    const task = this.tasks.get(taskId);
    if (!task || task.reported) return;
    this.updateTask(taskId, { reported: true });
  }

  // The user started talking while Jarvis was speaking.
  onBargeIn(): void {
    if (!this.bargeIn || this.state !== "speaking") return;
    this.holdReply();
    this.gen++;
    this.listen(BARGE_IN_CAPTURE, false);
  }

  stop(): void {
    this.denyAll("The user stopped Jarvis.");
    this.interruptReply();
    this.gen++;
    this.deps.listener.stopCapture();
    this.setState("idle");
  }

  onNoSpeech(): void {
    if (this.asking) {
      this.answer(false, "The user didn't answer, so this was not approved.");
      return;
    }
    if (!this.followUp) this.deps.emit({ type: "notice", text: "Didn't hear anything" });
    this.resolveHold(); // woke Jarvis, then said nothing: treat it as "stop"
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
    if (this.asking) {
      this.interruptPending = false; // "Hey Jarvis, yes" answers the question; it isn't an interruption
      this.deps.emit({ type: "transcript", text });
      const verdict = parseAnswer(text);
      if (verdict === "yes" && this.asking.destructive) {
        return this.askAgain("That one can't be undone, so please click Allow if you're sure.");
      }
      if (verdict) return this.answer(verdict === "yes");
      if (this.asking.retries++ === 0) return this.askAgain("Sorry, was that a yes or a no?");
      return this.answer(false, `The user replied "${text}", which wasn't a clear yes.`);
    }
    if (!text) {
      // Just "Hey Jarvis", then a pause: keep listening for the actual request.
      if (wasFollowUp) {
        this.resolveHold();
        this.setState("idle");
      } else {
        this.listen(CLICK_CAPTURE, false);
      }
      return;
    }
    this.deps.emit({ type: "transcript", text });

    if (isStopRequest(text)) {
      this.resolveHold();
      this.setState("idle");
      return;
    }
    const { sessions, history } = this.deps;
    const command = parseCommand(text);
    if (command.kind === "background" || command.kind === "list") {
      // Asking what's running mid-task also leaves the task running.
      const detached = this.interruptPending ? this.detach() : undefined;
      if (command.kind === "background") {
        if (detached) return this.say("Okay, I'll keep working on that and let you know when it's done.", gen);
        if (sessions.claude?.busy) {
          this.resolveHold();
          return this.say("I can only run three things at once, so I've stopped that one.", gen);
        }
        // Nothing was running: "keep going" is a normal request ("keep going with the story").
      }
    } else {
      this.resolveHold();
    }
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
        const running = sessions.running();
        const busy = new Set(running.map((s) => s.id));
        const recent = history.recent(6).filter((s) => !busy.has(s.id)).slice(0, 4);
        const parts: string[] = [];
        if (running.length > 0) {
          parts.push(`Working in the background: ${running.map((s) => s.title ?? spokenName(s.project)).join("; ")}.`);
        }
        if (recent.length > 0) {
          parts.push(`Recently: ${recent.map((s) => `${s.title ?? spokenName(s.project)}, ${whenSpoken(s.lastActiveAt)}`).join("; ")}.`);
        }
        return this.say(parts.join(" ") || "We haven't talked about anything yet.", gen);
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

    const { speaker, emit, sessions } = this.deps;
    const session = sessions.forTurn();
    const sessionId = sessions.record!.id;
    const splitter = new SentenceSplitter();
    let replyText = "";
    const tools: string[] = [];
    this.lastActivity = "";
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
        const activity = describeActivity(name, input);
        if (sessions.isBackground(sessionId)) {
          this.updateTask(sessionId, { activity });
        } else if (gen === this.gen) {
          this.lastActivity = activity;
          emit({ type: "tool", name, detail: toolDetail(input), activity });
        }
      },
    });
    this.turn = turn;
    const result = await turn;
    if (!result.isError || result.interrupted) {
      sessions.recordTurn(sessionId, text, replyText.trim(), tools, result.sessionId);
    }
    if (sessions.isBackground(sessionId)) {
      this.backgroundDone(sessionId, replyText, result.isError && !result.interrupted);
      return;
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

  private listen(opts: CaptureOptions, followUp: boolean, state: JarvisState = "listening"): void {
    this.followUp = followUp;
    this.deps.listener.startCapture(opts);
    this.setState(state);
  }

  // Called (via the approval server) when Claude needs permission for an edit or a command.
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const { question, detail } = describeRequest(request);
      const background = this.deps.sessions.isBackground(request.sessionId);
      const title = this.deps.history.get(request.sessionId)?.title;
      this.approvals.push({
        id: this.nextApprovalId++,
        request,
        question: background ? `Sorry to cut in. For ${title ?? "the background task"}: ${question}` : question,
        detail,
        destructive: isDestructive(request),
        taskId: background ? request.sessionId : undefined,
        retries: 0,
        resolve,
      });
      void this.askNext();
    });
  }

  // An answer clicked on the orb.
  answerFromUi(id: number, allow: boolean): void {
    if (this.asking?.id === id) this.answer(allow);
  }

  private async askNext(): Promise<void> {
    // Never cut into the user talking; asked again once the brain is back to thinking or idle.
    if (this.asking || this.approvals.length === 0 || this.state === "listening" || this.state === "transcribing") return;
    const approval = this.approvals.shift()!;
    this.asking = approval;
    await this.deps.speaker.idle(); // let the sentence in progress finish
    if (this.asking !== approval) return;
    this.deps.emit({
      type: "approval",
      id: approval.id,
      question: approval.question,
      detail: approval.detail,
      destructive: approval.destructive,
      taskId: approval.taskId,
    });
    await this.askAgain(approval.question);
  }

  private async askAgain(question: string): Promise<void> {
    const approval = this.asking;
    this.deps.speaker.say(question);
    await this.deps.speaker.idle();
    if (this.asking === approval) this.listen(ANSWER_CAPTURE, false, "asking");
  }

  private answer(allow: boolean, reason = "The user said no."): void {
    const approval = this.asking;
    if (!approval) return;
    this.asking = undefined;
    this.deps.listener.stopCapture();
    approval.resolve(allow
      ? { behavior: "allow", updatedInput: approval.request.input }
      : { behavior: "deny", message: reason });
    this.deps.emit({ type: "approval_done", id: approval.id, allowed: allow });
    // Claude carries on; its next words should light the orb up again.
    this.deps.speaker.onFirstAudio = () => {
      if (this.state === "thinking") this.setState("speaking");
    };
    this.setState(this.deps.sessions.claude?.busy ? "thinking" : "idle");
    void this.askNext();
  }

  private denyAll(reason: string): void {
    if (this.asking) this.answer(false, reason);
    for (const approval of this.approvals.splice(0)) {
      approval.resolve({ behavior: "deny", message: reason });
    }
  }

  private interruptReply(): void {
    this.interruptPending = false;
    this.deps.speaker.stop();
    if (this.deps.sessions.claude?.busy) this.deps.sessions.claude.interrupt();
  }

  // Silence Jarvis now; decide what happens to Claude's turn once we hear the request.
  private holdReply(): void {
    this.deps.speaker.stop();
    if (this.deps.sessions.claude?.busy) this.interruptPending = true;
  }

  // The request wasn't "keep going in the background": interrupt the held turn.
  private resolveHold(): void {
    if (this.interruptPending) this.interruptReply();
  }

  private detach(): ReturnType<SessionManager["detach"]> {
    const detached = this.deps.sessions.detach();
    if (detached) {
      this.interruptPending = false;
      this.turn = Promise.resolve(); // the next request doesn't wait for the background turn
      this.tasks.set(detached.id, {
        type: "task",
        id: detached.id,
        title: detached.title ?? "Your earlier request",
        project: detached.project,
        status: "running",
        activity: this.lastActivity,
        startedAt: Date.now(),
        reported: false,
      });
      this.deps.emit(this.tasks.get(detached.id)!);
    }
    return detached;
  }

  private updateTask(id: number, change: Partial<Extract<UiEvent, { type: "task" }>>): void {
    const task = this.tasks.get(id);
    if (!task) return;
    const title = this.deps.history.get(id)?.title; // titles arrive a few seconds after the first turn
    const updated = { ...task, ...(title ? { title } : {}), ...change };
    this.tasks.set(id, updated);
    this.deps.emit(updated);
  }

  private backgroundDone(sessionId: number, reply: string, failed: boolean): void {
    const { sessions, history, emit } = this.deps;
    sessions.finishBackground(sessionId);
    const name = history.get(sessionId)?.title ?? "your earlier request";
    const first = new SentenceSplitter();
    const lead = [...first.push(reply), ...first.flush()][0] ?? "";
    const text = failed ? `${name} ran into a problem, and nothing was changed after that.` : `Finished ${name}. ${lead}`.trim();
    this.updateTask(sessionId, { status: failed ? "failed" : "done", activity: "" });
    emit({ type: "task_report", taskId: sessionId, title: name, summary: reply.trim() || text });
    this.unreported.push({ taskId: sessionId, text });
    this.sound("done"); // the report waits for the next "Hey Jarvis"
  }

  private sound(name: "wake" | "done"): void {
    (this.deps.sound ?? playSound)(name);
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
    if (state === "thinking" || state === "speaking" || state === "idle") void this.askNext();
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

const SOUNDS = { wake: "/System/Library/Sounds/Pop.aiff", done: "/System/Library/Sounds/Glass.aiff" };

function playSound(name: "wake" | "done"): void {
  spawn("afplay", ["-v", "0.4", SOUNDS[name]], { stdio: "ignore" }).on("error", () => {});
}
