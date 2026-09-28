import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "./approval-server.ts";
import { describeActivity } from "./activity.ts";
import { describeRequest, isDestructive, parseAnswer } from "./approvals.ts";
import { ChangeTracker, spokenChanges, type FileChange } from "./changes.ts";
import { classifyClaudeError, unreachableMessage, type ClaudeProblem } from "./errors.ts";
import { parseCommand } from "./commands.ts";
import type { HistoryStore } from "./history.ts";
import { AllowRules, describeRule, ruleFor, type AllowRule } from "./rules.ts";
import type { Settings, VOICES } from "./settings.ts";
import type { CaptureOptions, Listener } from "./listener.ts";
import { SentenceSplitter } from "./sentences.ts";
import type { SessionManager } from "./sessions.ts";
import type { Speaker } from "./speaker.ts";
import type { Transcriber } from "./transcriber.ts";

// The turn state machine: wake -> listen -> transcribe -> think -> speak -> follow-up.
// Every activation bumps `gen`; async work from an older generation drops its result,
// which is how "Hey Jarvis" or a click interrupts whatever Jarvis was doing.

// "error": Claude can't be reached; the question is kept for Try again.
export type JarvisState = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "asking" | "error";

// Brain -> UI messages. native/JarvisUI.swift decodes the same shapes.
export type UiEvent =
  | { type: "state"; state: JarvisState; followUp: boolean }
  | { type: "level"; value: number }
  | { type: "transcript"; text: string }
  | { type: "partial_transcript"; text: string } // words appearing as you speak
  | { type: "reply_start" }
  | { type: "reply_delta"; text: string }
  | { type: "tool"; name: string; detail: string; activity: string }
  | { type: "reply_done"; error?: string }
  | { type: "notice"; text: string }
  | { type: "session"; id: number; title: string | null; project: string }
  // `always`: what "Always allow" would save ("Run “npm test” in jarvis-ai"); absent when not offered.
  | { type: "approval"; id: number; question: string; detail: string; destructive: boolean; taskId?: number; always?: string }
  | { type: "approval_done"; id: number; allowed: boolean }
  // A background task (its id is its session's id). `reported`: its result has been told to the user.
  | { type: "task"; id: number; title: string; project: string; status: TaskStatus; activity: string;
      startedAt: number; reported: boolean; request: string; origin: "voice" | "window"; cwd: string;
      claudeSessionId: string | null }
  | { type: "task_step"; taskId: number; tool: string; detail: string; at: number }
  | { type: "task_report"; taskId: number; title: string; summary: string; files: FileChange[]; diff: string;
      failed: boolean; error?: string }
  // Claude can't be reached (the red Error state): what to say, and the command that fixes it.
  | { type: "error"; reason: Extract<ClaudeProblem, { kind: "unreachable" }>["reason"]; text: string; command: string }
  // Settings and first-run setup.
  | { type: "settings"; values: Settings; locked: Array<keyof Settings>; voices: typeof VOICES;
      projects: Array<{ path: string; kind: string }>; permissionMode: string; dataDir: string }
  | { type: "claude_status"; installed: boolean; version?: string; loggedIn: boolean; plan?: string }
  | { type: "models"; whisper: boolean; kokoro: { loaded: number; total: number; done: boolean; failed: boolean } }
  | { type: "mic_status"; ok: boolean }
  // Saved "Always allow" rules, for Settings.
  | { type: "rules"; rules: Array<{ label: string; folder: string }> }
  // The History window: a search's results, and one conversation opened.
  | { type: "history_results"; query: string; project: string | null; projects: string[]; sessions: HistoryItem[] }
  | { type: "history_detail"; id: number; turns: Array<{ at: number; user: string; reply: string; tools: string[] }> };

export type HistoryItem = {
  id: number; title: string | null; summary: string | null; project: string; cwd: string; startedAt: number;
  lastActiveAt: number; turns: number; claudeSessionId: string | null;
  current: boolean; // the conversation the next "Hey Jarvis" goes to
  task: boolean; // a background task: opens in the Agents window
};

export type TaskStatus = "queued" | "running" | "done" | "failed" | "stopped";
type TaskEvent = Extract<UiEvent, { type: "task" }>;

// UI -> brain.
export type UiCommand =
  | { type: "activate" }
  | { type: "stop" }
  | { type: "quit" }
  | { type: "approve"; id: number; allow: boolean; always?: boolean }
  | { type: "rule_remove"; index: number }
  | { type: "retry" } // Try again, from the Error state
  | { type: "ptt"; down: boolean } // push to talk: F5 pressed or released
  | { type: "settings_set"; values: Partial<Settings> }
  | { type: "voice_sample"; voice: string }
  | { type: "claude_check" }
  | { type: "mic_check" }
  | { type: "history_clear" }
  | { type: "report_seen"; taskId: number }
  // The Agents window: start, steer and stop background tasks without speaking.
  | { type: "task_new"; text: string; project?: string }
  | { type: "task_note"; taskId: number; text: string }
  | { type: "task_stop"; taskId: number }
  // The History window: search, open a conversation, and make it the one "Hey Jarvis" continues.
  | { type: "history_query"; query: string; project?: string }
  | { type: "history_open"; id: number }
  | { type: "history_continue"; id: number };

const WAKE_CAPTURE: CaptureOptions = { preRollMs: 1500, noSpeechTimeoutMs: 5000 };
const CLICK_CAPTURE: CaptureOptions = { preRollMs: 200, noSpeechTimeoutMs: 6000 };
const FOLLOW_UP_CAPTURE: CaptureOptions = { preRollMs: 300, noSpeechTimeoutMs: 8000 };
const ANSWER_CAPTURE: CaptureOptions = { preRollMs: 300, noSpeechTimeoutMs: 10_000 };
// Push to talk: listens for as long as the key is held.
const HELD_CAPTURE: CaptureOptions = { preRollMs: 150, noSpeechTimeoutMs: 60_000, held: true };
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
  sound?: (name: Sound) => void;
  rules?: AllowRules; // "Always allow" answers; in memory when absent
  webWithoutAsking?: () => boolean; // Settings: searching and reading the web only reads, so skip the question

  // Interrupt by talking over Jarvis. Needs echo cancellation, or Jarvis hears itself.
  bargeIn?: boolean;
  // Live words while you speak: a small, fast Whisper (its own server, so the final transcript
  // never waits behind it), and how often to ask it. Off without one.
  partialTranscriber?: Pick<Transcriber, "transcribePcm">;
  partialsMs?: number;
};

type Sound = "wake" | "done" | "error";

type Approval = {
  id: number;
  request: ApprovalRequest;
  question: string;
  detail: string;
  destructive: boolean; // needs a click, not a spoken yes
  taskId?: number;
  rule?: AllowRule; // what "Always allow" saves
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
  private tasks = new Map<number, TaskEvent>();
  private taskPrompts = new Map<number, string>(); // queued tasks: what to ask once a slot frees
  private taskControl = new Map<number, { note?: string; stop?: boolean }>(); // requests for a running turn
  private currentRequest = ""; // what the user asked in the current turn, kept if it moves to the background
  private unreported: Array<{ taskId: number; text: string }> = [];
  private lastActivity = ""; // the current turn's latest "what Jarvis is doing", carried into a handoff
  // Claude asking permission (edits, commands): one question at a time, answered by voice or on the orb.
  private approvals: Array<Approval> = [];
  private asking: Approval | undefined;
  private nextApprovalId = 1;
  private rules: AllowRules;
  private failedRequest: { text: string; prompt: string } | undefined; // kept for Try again
  private taskNotBefore = new Map<number, number>(); // queued until a usage limit resets
  private partials: ReturnType<typeof setInterval> | undefined;
  private partialBusy = false;
  private changes = new Map<number, ChangeTracker>(); // per session: files touched, for task reports

  constructor(deps: JarvisDeps) {
    this.deps = deps;
    this.bargeIn = deps.bargeIn ?? false;
    this.rules = deps.rules ?? new AllowRules();
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

  // Push to talk (hold F5): listen while the key is down; releasing it ends what you said.
  pushToTalk(down: boolean): void {
    if (!down) {
      if (this.state === "listening" || this.state === "asking") this.deps.listener.finishCapture();
      return;
    }
    if (this.asking) {
      this.listen(HELD_CAPTURE, false, "asking");
      return;
    }
    this.holdReply();
    this.gen++;
    this.sound("wake");
    this.listen(HELD_CAPTURE, false);
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
    if (!this.followUp) {
      this.deps.emit({ type: "notice", text: "Didn't catch that" });
      this.deps.speaker.say("I didn't catch that.");
    }
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
      if (verdict) return this.answer(verdict === "yes", undefined, verdict === "yes" && /\balways\b/i.test(text));
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
          const most = ["no", "one", "two", "three", "four"][sessions.maxBackground] ?? String(sessions.maxBackground);
          return this.say(`I can only run ${most} ${sessions.maxBackground === 1 ? "thing" : "things"} at once, so I've stopped that one.`, gen);
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
    const changes = new ChangeTracker(sessions.record!.cwd);
    this.changes.set(sessionId, changes); // carried into a task if this turn moves to the background
    const splitter = new SentenceSplitter();
    let replyText = "";
    const tools: string[] = [];
    this.lastActivity = "";
    this.currentRequest = text;
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
        changes.onTool(name, input);
        const activity = describeActivity(name, input);
        if (sessions.isBackground(sessionId)) {
          this.taskStep(sessionId, name, input);
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
      this.afterBackgroundTurn(sessionId, replyText, result.isError && !result.interrupted, result.text);
      return;
    }
    if (gen !== this.gen) return;

    for (const sentence of splitter.flush()) speaker.say(sentence);
    if (result.isError && !result.interrupted) {
      const problem = classifyClaudeError(result.text);
      if (problem.kind === "unreachable") return this.unreachable(problem.reason, text, prompt);
      emit({ type: "reply_done", error: problem.kind === "limit" ? undefined : result.text });
      speaker.say(problem.kind === "limit" ? this.limitReached(problem, prompt) : "Sorry, something went wrong.");
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

  // The red Error state: say what's wrong once, with a low tone, and keep the question for Try again.
  private async unreachable(reason: Extract<ClaudeProblem, { kind: "unreachable" }>["reason"], text: string,
                            prompt: string): Promise<void> {
    const { speaker, emit } = this.deps;
    this.failedRequest = { text, prompt };
    emit({ type: "reply_done" });
    speaker.onFirstAudio = undefined;
    this.sound("error");
    this.setState("error");
    const message = unreachableMessage(reason);
    emit({ type: "error", reason, text: message, command: "claude" });
    speaker.say(message);
    await speaker.idle();
  }

  // Try again: asks the kept question once more.
  retry(): void {
    const failed = this.failedRequest;
    if (!failed || this.state !== "error") return;
    this.failedRequest = undefined;
    this.deps.speaker.stop();
    const gen = ++this.gen;
    void this.reply(failed.text, gen, failed.prompt);
  }

  // A usage limit is an ordinary reply: say so, and queue the request as a task for when it resets.
  private limitReached(problem: Extract<ClaudeProblem, { kind: "limit" }>, prompt: string): string {
    if (!problem.resetAt) return "You've reached your Claude usage limit, so I can't do that right now. Please ask again once it resets.";
    this.startTask(prompt, undefined, { cwd: this.deps.sessions.record?.cwd, notBefore: problem.resetAt + 60_000,
      waiting: `Starts after the usage limit resets at ${problem.resetText}` });
    return `You've reached your Claude usage limit. It resets at ${problem.resetText}, so I'll do this in the background then.`;
  }

  private listen(opts: CaptureOptions, followUp: boolean, state: JarvisState = "listening"): void {
    this.followUp = followUp;
    this.deps.listener.startCapture(opts);
    this.setState(state);
  }

  // Called (via the approval server) when Claude needs permission for an edit or a command.
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const record = this.deps.history.get(request.sessionId);
    const cwd = record?.cwd ?? this.deps.sessions.defaultCwd;
    const web = request.toolName === "WebSearch" || request.toolName === "WebFetch";
    if (this.rules.allows(request, cwd) || (web && this.deps.webWithoutAsking?.())) {
      return Promise.resolve({ behavior: "allow", updatedInput: request.input });
    }
    return new Promise((resolve) => {
      const { question, detail } = describeRequest(request);
      const background = this.deps.sessions.isBackground(request.sessionId);
      const title = record?.title;
      this.approvals.push({
        id: this.nextApprovalId++,
        request,
        question: background ? `Sorry to cut in. For ${title ?? "the background task"}: ${question}` : question,
        detail,
        destructive: isDestructive(request),
        taskId: background ? request.sessionId : undefined,
        rule: ruleFor(request, cwd),
        retries: 0,
        resolve,
      });
      void this.askNext();
    });
  }

  // An answer clicked on the orb.
  answerFromUi(id: number, allow: boolean, always = false): void {
    if (this.asking?.id === id) this.answer(allow, undefined, always);
  }

  // Settings: the saved "Always allow" rules.
  rulesEvent(): UiEvent {
    return {
      type: "rules",
      rules: this.rules.rules.map((rule) => ({ label: describeRule(rule), folder: rule.cwd })),
    };
  }

  removeRule(index: number): void {
    this.rules.remove(index);
    this.deps.emit(this.rulesEvent());
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
      always: approval.rule && `${describeRule(approval.rule)} in ${basename(approval.rule.cwd) || approval.rule.cwd}`,
    });
    await this.askAgain(approval.question);
  }

  private async askAgain(question: string): Promise<void> {
    const approval = this.asking;
    this.deps.speaker.say(question);
    await this.deps.speaker.idle();
    if (this.asking === approval) this.listen(ANSWER_CAPTURE, false, "asking");
  }

  private answer(allow: boolean, reason = "The user said no.", always = false): void {
    const approval = this.asking;
    if (!approval) return;
    this.asking = undefined;
    if (allow && always && approval.rule) {
      this.rules.add(approval.rule);
      this.deps.emit(this.rulesEvent());
    }
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
        title: detached.title ?? titleFrom(this.currentRequest),
        project: detached.project,
        status: "running",
        activity: this.lastActivity,
        startedAt: Date.now(),
        reported: false,
        request: this.currentRequest,
        origin: "voice",
        cwd: detached.cwd,
        claudeSessionId: detached.claudeSessionId,
      });
      this.deps.emit(this.tasks.get(detached.id)!);
    }
    return detached;
  }

  private updateTask(id: number, change: Partial<TaskEvent>): void {
    const task = this.tasks.get(id);
    if (!task) return;
    const record = this.deps.history.get(id); // titles arrive a few seconds after the first turn
    const updated = {
      ...task,
      ...(record?.title ? { title: record.title } : {}),
      claudeSessionId: record?.claudeSessionId ?? task.claudeSessionId,
      ...change,
    };
    this.tasks.set(id, updated);
    this.deps.emit(updated);
  }

  // --- The History window ---

  historyQuery(query: string, project?: string): void {
    const { history, sessions } = this.deps;
    const current = sessions.record?.id;
    this.deps.emit({
      type: "history_results",
      query,
      project: project ?? null,
      projects: history.projects(),
      sessions: history.search(query, { project }).map((s) => ({
        ...s,
        current: s.id === current,
        task: this.tasks.has(s.id),
      })),
    });
  }

  historyOpen(id: number): void {
    this.deps.emit({ type: "history_detail", id, turns: this.deps.history.transcript(id) });
  }

  // "Continue with Jarvis": the next "Hey Jarvis" goes to that conversation.
  historyContinue(id: number): void {
    const { history, sessions, emit } = this.deps;
    const record = history.get(id);
    if (!record) return;
    if (sessions.isBackground(id)) {
      emit({ type: "notice", text: "That one is still working in the background." });
      return;
    }
    if (sessions.record?.id !== id) sessions.resume(record);
    emit({ type: "notice", text: `Your next “Hey Jarvis” continues “${record.title ?? record.project}”.` });
  }

  // --- Background tasks started, steered and stopped from the Agents window ---

  // "New task…": runs in the background, in the named project folder if one matches.
  // Queued when all background slots are busy. Returns the task's id.
  startTask(text: string, project?: string, opts: { cwd?: string; notBefore?: number; waiting?: string } = {}): number {
    const { sessions, history } = this.deps;
    const cwd = opts.cwd ?? ((project && sessions.findProject(project)) || sessions.defaultCwd);
    const record = history.createSession(cwd, basename(cwd));
    this.tasks.set(record.id, {
      type: "task",
      id: record.id,
      title: titleFrom(text),
      project: record.project,
      status: "queued",
      activity: opts.waiting ?? "",
      startedAt: Date.now(),
      reported: false,
      request: text,
      origin: opts.notBefore ? "voice" : "window",
      cwd,
      claudeSessionId: null,
    });
    this.taskPrompts.set(record.id, text);
    if (opts.notBefore) {
      this.taskNotBefore.set(record.id, opts.notBefore);
      setTimeout(() => this.startQueued(), Math.max(0, opts.notBefore - Date.now())).unref();
    }
    this.deps.emit(this.tasks.get(record.id)!);
    this.startQueued();
    return record.id;
  }

  // A note to a task: a running one is interrupted and carries on with the note (the design
  // doc's fallback; the CLI can't take a message mid-turn); a finished one gets it as a follow-up.
  noteTask(id: number, text: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "queued") {
      this.taskPrompts.set(id, `${this.taskPrompts.get(id) ?? ""}

${text}`.trim());
      return;
    }
    if (task.status === "running") {
      this.taskControl.set(id, { ...this.taskControl.get(id), note: text });
      this.deps.sessions.backgroundClaude(id)?.interrupt();
      return;
    }
    this.unreported = this.unreported.filter((r) => r.taskId !== id);
    this.taskPrompts.set(id, text);
    this.updateTask(id, { status: "queued", reported: false, activity: "" });
    this.startQueued();
  }

  stopTask(id: number): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.denyForTask(id, "The user stopped this task.");
    if (task.status === "queued") {
      this.taskPrompts.delete(id);
      this.updateTask(id, { status: "stopped" });
    } else if (task.status === "running") {
      this.taskControl.set(id, { stop: true });
      this.deps.sessions.backgroundClaude(id)?.interrupt();
    }
  }

  private startQueued(): void {
    const { sessions, history } = this.deps;
    for (const task of [...this.tasks.values()]) {
      if (task.status !== "queued" || !sessions.canStartBackground()) continue;
      if ((this.taskNotBefore.get(task.id) ?? 0) > Date.now()) continue;
      this.taskNotBefore.delete(task.id);
      const record = history.get(task.id);
      const prompt = this.taskPrompts.get(task.id);
      if (!record || prompt === undefined) continue;
      this.taskPrompts.delete(task.id);
      sessions.startBackground(record.cwd, record.turns > 0 ? record : { ...record, claudeSessionId: null });
      this.changes.set(task.id, new ChangeTracker(record.cwd));
      this.updateTask(task.id, { status: "running", startedAt: Date.now(), activity: "" });
      void this.runTaskTurn(task.id, prompt, prompt);
    }
  }

  // One turn of a background task (a window task, a note, or a follow-up).
  private async runTaskTurn(id: number, prompt: string, userText: string): Promise<void> {
    const { sessions } = this.deps;
    const claude = sessions.backgroundClaude(id);
    if (!claude) return;
    let replyText = "";
    const tools: string[] = [];
    const result = await claude.ask(prompt, {
      onText: (delta) => (replyText += delta),
      onTool: (name, input) => {
        tools.push(`${name} ${toolDetail(input)}`.trim());
        this.changes.get(id)?.onTool(name, input);
        this.taskStep(id, name, input);
      },
    });
    if (!result.isError || result.interrupted) sessions.recordTurn(id, userText, replyText.trim(), tools, result.sessionId);
    this.afterBackgroundTurn(id, replyText, result.isError && !result.interrupted, result.text);
  }

  // A background turn ended: stop it, carry on with a note, or finish and report.
  private afterBackgroundTurn(id: number, reply: string, failed: boolean, error = ""): void {
    const control = this.taskControl.get(id);
    this.taskControl.delete(id);
    if (control?.stop) {
      this.deps.sessions.finishBackground(id);
      this.updateTask(id, { status: "stopped", activity: "" });
    } else if (control?.note) {
      const note = control.note;
      void this.runTaskTurn(id, `A note from the user while you were working: ${note}\nTake it into account and carry on.`, note);
      return;
    } else {
      this.backgroundDone(id, reply, failed, error);
    }
    this.startQueued();
  }

  private taskStep(id: number, tool: string, input: Record<string, unknown>): void {
    const activity = describeActivity(tool, input);
    this.deps.emit({ type: "task_step", taskId: id, tool, detail: activity, at: Date.now() });
    this.updateTask(id, { activity });
  }

  private denyForTask(id: number, reason: string): void {
    if (this.asking?.taskId === id) this.answer(false, reason);
    this.approvals = this.approvals.filter((approval) => {
      if (approval.taskId !== id) return true;
      approval.resolve({ behavior: "deny", message: reason });
      return false;
    });
  }

  private backgroundDone(sessionId: number, reply: string, failed: boolean, error = ""): void {
    const { sessions, history, emit } = this.deps;
    sessions.finishBackground(sessionId);
    const name = history.get(sessionId)?.title ?? "your earlier request";
    const first = new SentenceSplitter();
    const lead = [...first.push(reply), ...first.flush()][0] ?? "";
    const tracker = this.changes.get(sessionId);
    this.changes.delete(sessionId);
    const { files, diff } = tracker?.collect() ?? { files: [], diff: "" };
    const changed = tracker && tracker.touched > 0 ? ` ${spokenChanges(files)}` : "";
    // A failed task: what failed, whether anything changed, and the failing line.
    const failingLine = (error || reply).split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200);
    const text = failed
      ? `${name} ran into a problem${failingLine ? `: ${failingLine.replace(/\.$/, "")}` : ""}.${files.length > 0 ? changed : " No files were changed."}`
      : `Finished ${name}. ${lead}${changed}`.replace(/\s+/g, " ").trim();
    this.updateTask(sessionId, { status: failed ? "failed" : "done", activity: "" });
    emit({ type: "task_report", taskId: sessionId, title: name, summary: failed ? text : reply.trim() || text, files, diff,
      failed, ...(failed && failingLine ? { error: failingLine } : {}) });
    this.unreported.push({ taskId: sessionId, text });
    this.sound("done"); // the report waits for the next "Hey Jarvis"
  }

  private sound(name: Sound): void {
    (this.deps.sound ?? playSound)(name);
  }

  private fail(message: string): void {
    this.deps.emit({ type: "notice", text: message });
    this.setState("idle");
  }

  // Live words: while listening, transcribe what's been said so far every so often (one
  // request at a time), and show it until the final transcript arrives.
  private livePartials(on: boolean): void {
    const every = this.deps.partialsMs ?? 0;
    const transcriber = this.deps.partialTranscriber;
    if (!on || every <= 0 || !transcriber) {
      if (this.partials) clearInterval(this.partials);
      this.partials = undefined;
      return;
    }
    if (this.partials) return;
    this.partials = setInterval(() => {
      const audio = this.deps.listener.speechSoFar;
      const gen = this.gen;
      if (!audio || this.partialBusy) return;
      this.partialBusy = true;
      transcriber.transcribePcm(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength))
        .then((text) => {
          const words = stripWakePhrase(text);
          if (words && gen === this.gen && (this.state === "listening" || this.state === "asking")) {
            this.deps.emit({ type: "partial_transcript", text: words });
          }
        }, () => {})
        .finally(() => (this.partialBusy = false));
    }, every);
  }

  private setState(state: JarvisState): void {
    if (state !== "listening") this.followUp = false;
    if (state === this.state && state !== "listening") return;
    this.state = state;
    this.deps.listener.watchForSpeech(this.bargeIn && state === "speaking");
    this.livePartials(state === "listening" || state === "asking");
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

// A task's name until Claude's title arrives: the request, cut short.
function titleFrom(request: string): string {
  const text = request.trim().replace(/\s+/g, " ");
  return text.length > 48 ? `${text.slice(0, 47)}…` : text || "Background task";
}

function toolDetail(input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? "";
  return String(detail).split("\n")[0].slice(0, 80);
}

const SOUNDS = {
  wake: "/System/Library/Sounds/Pop.aiff",
  done: "/System/Library/Sounds/Glass.aiff",
  error: "/System/Library/Sounds/Basso.aiff", // the short low tone of the Error state
};

function playSound(name: Sound): void {
  spawn("afplay", ["-v", "0.4", SOUNDS[name]], { stdio: "ignore" }).on("error", () => {});
}
