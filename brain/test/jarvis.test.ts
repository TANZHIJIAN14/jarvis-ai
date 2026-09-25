import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSession, TurnHandlers, TurnResult } from "../src/claude-session.ts";
import { HistoryStore } from "../src/history.ts";
import { SessionManager } from "../src/sessions.ts";
import { isStopRequest, Jarvis, stripWakePhrase, type UiEvent } from "../src/jarvis.ts";
import type { CaptureOptions, Listener } from "../src/listener.ts";
import type { Speaker } from "../src/speaker.ts";
import type { Transcriber } from "../src/transcriber.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A Claude session whose turns the test finishes by hand.
function fakeSession() {
  const turns: Array<{ text: string; handlers: TurnHandlers; finish: (r: Partial<TurnResult>) => void }> = [];
  let interrupted = 0;
  const session = {
    get busy() {
      return turns.some((t) => !("done" in t));
    },
    ask(text: string, handlers: TurnHandlers) {
      return new Promise<TurnResult>((resolve) => {
        const turn = {
          text,
          handlers,
          finish: (r: Partial<TurnResult>) => {
            Object.assign(turn, { done: true });
            resolve({ text: "", isError: false, interrupted: false, sessionId: "s1", ...r });
          },
        };
        turns.push(turn);
      });
    },
    interrupt() {
      interrupted++;
      turns.filter((t) => !("done" in t)).forEach((t) => t.finish({ interrupted: true }));
    },
    close() {},
    warm() {},
  };
  return { session: session as unknown as ClaudeSession, turns, interrupts: () => interrupted };
}

function setup(transcripts: string[], opts: { bargeIn?: boolean; history?: HistoryStore } = {}) {
  const events: UiEvent[] = [];
  const captures: CaptureOptions[] = [];
  const watching: boolean[] = [];
  const spoken: string[] = [];
  const claude = fakeSession();
  const speaker = {
    onFirstAudio: undefined as (() => void) | undefined,
    say(s: string) {
      spoken.push(s);
      this.onFirstAudio?.();
      this.onFirstAudio = undefined;
    },
    stop() {},
    idle: async () => {},
  };
  const history = opts.history ?? new HistoryStore(":memory:");
  const projectsDir = mkdtempSync(join(tmpdir(), "jarvis-projects-"));
  mkdirSync(join(projectsDir, "payments-platform"));
  const claudeStarts: Array<{ cwd: string; resume?: string }> = [];
  const sessions = new SessionManager({
    history,
    newClaude: (o) => {
      claudeStarts.push(o);
      return claude.session;
    },
    defaultCwd: "/tmp/jarvis-workspace",
    projectsDir,
  });
  const jarvis = new Jarvis({
    listener: {
      startCapture: (o: CaptureOptions) => captures.push(o),
      stopCapture() {},
      watchForSpeech: (on: boolean) => watching.push(on),
    } as unknown as Listener,
    transcriber: { transcribePcm: async () => transcripts.shift() ?? "" } as unknown as Transcriber,
    speaker: speaker as unknown as Speaker,
    sessions,
    history,
    emit: (e) => events.push(e),
    chime: () => {},
    bargeIn: opts.bargeIn,
  });
  const states = () => events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state);
  return { jarvis, events, captures, spoken, claude, states, watching, history, claudeStarts, projectsDir };
}

test("a full turn: wake, transcribe, reply by voice, then a follow-up window", async () => {
  const { jarvis, captures, spoken, claude, states } = setup(["Hey Jarvis, what time is it?"]);
  jarvis.activate(true);
  assert.equal(captures[0].preRollMs, 1500, "keeps the wake phrase audio");

  const done = jarvis.onUtterance(new Int16Array(16));
  await tick();
  assert.equal(claude.turns[0].text, "what time is it?", "wake phrase stripped");
  claude.turns[0].handlers.onText!("It's three o'clock. ");
  claude.turns[0].handlers.onText!("Anything else?");
  claude.turns[0].finish({ text: "It's three o'clock. Anything else?" });
  await done;

  assert.deepEqual(spoken, ["It's three o'clock.", "Anything else?"]);
  assert.deepEqual(states(), ["listening", "transcribing", "thinking", "speaking", "listening"]);
  assert.equal(captures[1].noSpeechTimeoutMs, 8000, "follow-up window");
  assert.equal(jarvis.followUp, true);
});

test("saying the wake word mid-reply interrupts Claude and listens again", async () => {
  const { jarvis, spoken, claude, states } = setup(["Jarvis, tell me a long story", "never mind, what's the weather"]);
  jarvis.activate(true);
  const first = jarvis.onUtterance(new Int16Array(16));
  await tick();
  claude.turns[0].handlers.onText!("Once upon a time, ");

  jarvis.activate(true); // barge-in
  assert.equal(claude.interrupts(), 1);
  await first;
  assert.equal(states().at(-1), "listening", "the old turn doesn't take over the state");

  const second = jarvis.onUtterance(new Int16Array(16));
  await tick();
  await tick();
  assert.equal(claude.turns[1].text, "never mind, what's the weather");
  claude.turns[1].handlers.onText!("Sunny.");
  claude.turns[1].finish({});
  await second;
  assert.deepEqual(spoken, ["Sunny."], "nothing from the interrupted story is spoken late");
});

test("just the wake word, then a pause: keeps listening for the request", async () => {
  const { jarvis, captures, claude } = setup(["Hey Jarvis."]);
  jarvis.activate(true);
  await jarvis.onUtterance(new Int16Array(16));
  assert.equal(claude.turns.length, 0);
  assert.equal(captures.length, 2);
  assert.equal(jarvis.state, "listening");
});

test("strips the wake phrase and common mishearings", () => {
  assert.equal(stripWakePhrase("Hey Jarvis, open the repo."), "open the repo.");
  assert.equal(stripWakePhrase("Hey, Garvis. What's up?"), "What's up?");
  assert.equal(stripWakePhrase("Jarvis"), "");
  assert.equal(stripWakePhrase("Tell Jarvis hello"), "Tell Jarvis hello");
});

test("talking over Jarvis interrupts it and captures what was said", async () => {
  const { jarvis, captures, claude, watching, states } = setup(["Jarvis, explain the build", "wait, use the other branch"], { bargeIn: true });
  jarvis.activate(true);
  const first = jarvis.onUtterance(new Int16Array(16));
  await tick();
  claude.turns[0].handlers.onText!("The build has three steps. ");
  assert.equal(jarvis.state, "speaking");
  assert.equal(watching.at(-1), true, "watches for speech only while speaking");

  jarvis.onBargeIn();
  assert.equal(claude.interrupts(), 1);
  assert.equal(watching.at(-1), false);
  assert.equal(captures.at(-1)!.speechStarted, true, "the interrupting words are in the pre-roll");
  await first;
  assert.equal(states().at(-1), "listening");

  const second = jarvis.onUtterance(new Int16Array(16));
  await tick();
  await tick();
  assert.equal(claude.turns[1].text, "wait, use the other branch");
  claude.turns[1].finish({});
  await second;
});

test("without echo cancellation, speech never arms barge-in", async () => {
  const { jarvis, claude, watching } = setup(["Jarvis, explain the build"]);
  jarvis.activate(true);
  const first = jarvis.onUtterance(new Int16Array(16));
  await tick();
  claude.turns[0].handlers.onText!("The build has three steps. ");
  assert.equal(jarvis.state, "speaking");
  assert.ok(watching.every((on) => !on));
  jarvis.onBargeIn(); // ignored: nothing to act on
  assert.equal(claude.interrupts(), 0);
  claude.turns[0].finish({});
  await first;
});

test("a bare 'stop' after interrupting goes quiet instead of asking Claude", async () => {
  const { jarvis, claude } = setup(["Stop."]);
  jarvis.activate(true);
  await jarvis.onUtterance(new Int16Array(16));
  assert.equal(claude.turns.length, 0);
  assert.equal(jarvis.state, "idle");
});

test("recognises 'stop' requests, including repeats and filler, but not real questions", () => {
  for (const t of ["Stop.", "Stop, man. Stop.", "Okay, that's enough.", "Hey Jarvis, wait.", "Never mind.", "Hold on a second", "Thank you."]) {
    assert.ok(isStopRequest(t), t);
  }
  for (const t of ["Stop the dev server", "Wait, use the other branch", "Okay, can you start over again?", "No.", ""]) {
    assert.ok(!isStopRequest(t), t);
  }
});

async function turn(ctx: ReturnType<typeof setup>, reply: string) {
  ctx.jarvis.activate(true);
  const done = ctx.jarvis.onUtterance(new Int16Array(16));
  await tick();
  const t = ctx.claude.turns.at(-1);
  if (t && !("done" in t)) {
    t.handlers.onText!(reply);
    t.finish({ text: reply, sessionId: `claude-${ctx.claude.turns.length}` });
  }
  await done;
}

test("records each turn in the history", async () => {
  const ctx = setup(["Hey Jarvis, plan the Kokoro voice work"]);
  await turn(ctx, "Let's start with the voice samples.");
  const [session] = ctx.history.recent();
  assert.equal(session.turns, 1);
  assert.equal(session.claudeSessionId, "claude-1");
  assert.deepEqual(ctx.history.transcript(session.id).map((t) => [t.user, t.reply]), [
    ["plan the Kokoro voice work", "Let's start with the voice samples."],
  ]);
});

test("'go back to …' resumes a past session by what it was about", async () => {
  const ctx = setup(["Jarvis, plan the Kokoro voice work", "new session", "Jarvis, go back to the Kokoro voice"]);
  await turn(ctx, "Let's start with the voice samples.");
  await turn(ctx, "");
  assert.deepEqual(ctx.spoken.slice(-1), ["Okay, starting fresh."]);
  await turn(ctx, "");
  assert.match(ctx.spoken.at(-1)!, /^Back to our conversation from earlier today\.$/);
  assert.deepEqual(ctx.claudeStarts.at(-1), { cwd: "/tmp/jarvis-workspace", resume: "claude-1" });
  assert.equal(ctx.claude.turns.length, 1, "commands never reach Claude");
});

test("'go back to …' with no matching session is just a request", async () => {
  const ctx = setup(["Jarvis, continue the story"]);
  await turn(ctx, "And then the lighthouse keeper...");
  assert.equal(ctx.claude.turns[0].text, "continue the story");
});

test("'switch to the … project' starts a session in that folder", async () => {
  const ctx = setup(["Hey Jarvis, switch to the payments platform project"]);
  await turn(ctx, "");
  assert.equal(ctx.spoken.at(-1), "Okay, working in payments platform now.");
  assert.equal(ctx.claudeStarts.at(-1)!.cwd, join(ctx.projectsDir, "payments-platform"));
});

test("'what did we decide about …' hands Claude the relevant past turns", async () => {
  const ctx = setup(["Jarvis, which voice should we use?", "new session", "What did we decide about the voice?"]);
  await turn(ctx, "Let's go with George, the British Kokoro voice.");
  await turn(ctx, "");
  await turn(ctx, "We picked George.");
  const prompt = ctx.claude.turns.at(-1)!.text;
  assert.match(prompt, /^What did we decide about the voice\?/);
  assert.match(prompt, /George, the British Kokoro voice/);
  assert.equal(ctx.history.transcript(ctx.history.recent()[0].id)[0].user, "What did we decide about the voice?",
    "history keeps what the user said, not the notes");
});
