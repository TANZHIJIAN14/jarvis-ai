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
  const claudeStarts: Array<{ cwd: string; resume?: string; sessionId: number }> = [];
  const sessions = new SessionManager({
    history,
    newClaude: (o) => {
      claudeStarts.push(o);
      return claude.session;
    },
    defaultCwd: "/tmp/jarvis-workspace",
    projectsDir,
  });
  const sounds: string[] = [];
  const jarvis = new Jarvis({
    sound: (name) => sounds.push(name),
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
    bargeIn: opts.bargeIn,
  });
  const states = () => events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state);
  return { jarvis, events, captures, spoken, claude, states, watching, history, claudeStarts, projectsDir, sounds };
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

test("saying the wake word mid-reply silences Jarvis; a new request interrupts Claude", async () => {
  const { jarvis, spoken, claude, states } = setup(["Jarvis, tell me a long story", "never mind, what's the weather"]);
  jarvis.activate(true);
  const first = jarvis.onUtterance(new Int16Array(16));
  await tick();
  claude.turns[0].handlers.onText!("Once upon a time, ");

  jarvis.activate(true); // barge-in
  assert.equal(claude.interrupts(), 0, "Claude keeps working until we know what the user wants");
  assert.equal(states().at(-1), "listening");

  const second = jarvis.onUtterance(new Int16Array(16));
  await first;
  assert.equal(claude.interrupts(), 1);
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
  assert.equal(watching.at(-1), false);
  assert.equal(captures.at(-1)!.speechStarted, true, "the interrupting words are in the pre-roll");
  assert.equal(states().at(-1), "listening");

  const second = jarvis.onUtterance(new Int16Array(16));
  await first;
  assert.equal(claude.interrupts(), 1);
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
  assert.deepEqual(ctx.claudeStarts.at(-1), { cwd: "/tmp/jarvis-workspace", resume: "claude-1", sessionId: 1 });
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

test("'keep going in the background' leaves Claude working; the result waits for the next wake", async () => {
  const ctx = setup(["Jarvis, refactor the auth module", "keep going in the background", "what time is it?", "Hey Jarvis"]);
  const { jarvis, claude, spoken, events, sounds } = ctx;
  jarvis.activate(true);
  const first = jarvis.onUtterance(new Int16Array(16));
  await tick();
  claude.turns[0].handlers.onText!("Starting on the auth module. ");

  jarvis.activate(true);
  await jarvis.onUtterance(new Int16Array(16));
  assert.equal(claude.interrupts(), 0, "the task was not killed");
  assert.equal(spoken.at(-1), "Okay, I'll keep working on that and let you know when it's done.");
  const running = events.filter((e) => e.type === "task").at(-1) as Extract<UiEvent, { type: "task" }>;
  assert.equal(running.status, "running");
  assert.equal(running.id, 1);

  // Its tool use shows up as the task's activity.
  claude.turns[0].handlers.onTool!("Read", { file_path: "/x/src/auth.ts" });
  assert.equal((events.filter((e) => e.type === "task").at(-1) as { activity: string }).activity, "Reading auth.ts");

  // The next request goes to a fresh session while the first keeps running.
  jarvis.activate(true);
  const third = jarvis.onUtterance(new Int16Array(16));
  await tick();
  assert.equal(ctx.claudeStarts.length, 2, "a new Claude session for the next request");
  claude.turns[1].handlers.onText!("It's three.");
  claude.turns[1].finish({ text: "It's three.", sessionId: "c2" });
  await third;

  jarvis.stop();
  const spokenBefore = spoken.length;
  claude.turns[0].handlers.onText!("Done: I split it into three files.");
  claude.turns[0].finish({ text: "Done", sessionId: "c1" });
  await first;
  await tick();
  assert.equal(spoken.length, spokenBefore, "finished work waits quietly");
  assert.ok(sounds.includes("done"), "a chime marks it");
  const done = events.filter((e) => e.type === "task").at(-1) as Extract<UiEvent, { type: "task" }>;
  assert.equal(done.status, "done");
  assert.equal(done.reported, false);
  assert.ok(events.some((e) => e.type === "task_report" && e.taskId === 1));

  // Reported first on the next "Hey Jarvis", then Jarvis listens for the question.
  jarvis.activate(true);
  await tick();
  await tick();
  assert.match(spoken.at(-2)!, /^Quick update first: Finished your earlier request\. Starting on the auth module\./);
  assert.equal(spoken.at(-1), "What did you want to ask?");
  assert.equal(jarvis.state, "listening");
  assert.equal((events.filter((e) => e.type === "task").at(-1) as { reported: boolean }).reported, true);
  assert.equal(ctx.history.transcript(1)[0].user, "refactor the auth module", "recorded in its own session");
});

test("'keep going' with nothing running is a normal request", async () => {
  const ctx = setup(["keep going with the story"]);
  await turn(ctx, "And then...");
  assert.equal(ctx.claude.turns[0].text, "keep going with the story");
});

test("'what's running?' lists background tasks", async () => {
  const ctx = setup(["Jarvis, refactor the auth module", "keep going in the background", "what's running?"]);
  ctx.jarvis.activate(true);
  void ctx.jarvis.onUtterance(new Int16Array(16));
  await tick();
  ctx.jarvis.activate(true);
  await ctx.jarvis.onUtterance(new Int16Array(16));
  ctx.jarvis.activate(true);
  await ctx.jarvis.onUtterance(new Int16Array(16));
  assert.match(ctx.spoken.at(-1)!, /^Working in the background: jarvis workspace\.$/);
});

test("asks out loud before an edit or command, and passes the answer to Claude", async () => {
  const ctx = setup(["Jarvis, run the tests", "yes, go ahead"]);
  const { jarvis, claude, spoken, events, captures } = ctx;
  jarvis.activate(true);
  const reply = jarvis.onUtterance(new Int16Array(16));
  await tick();
  const decision = jarvis.requestApproval({
    sessionId: 1,
    toolName: "Bash",
    input: { command: "npm test", description: "Run the test suite in jarvis-ai" },
  });
  await tick();
  assert.equal(spoken.at(-1), "May I run the test suite in jarvis-ai?");
  assert.equal(jarvis.state, "asking");
  assert.equal(captures.at(-1)!.noSpeechTimeoutMs, 10_000);
  assert.ok(events.some((e) => e.type === "approval" && e.detail === "npm test"), "the exact command is shown");

  await jarvis.onUtterance(new Int16Array(16));
  assert.deepEqual(await decision, { behavior: "allow", updatedInput: { command: "npm test", description: "Run the test suite in jarvis-ai" } });
  assert.equal(jarvis.state, "thinking", "back to Claude's work");
  claude.turns[0].finish({});
  await reply;
});

test("silence, a no, or an unclear answer twice means not approved", async () => {
  const ctx = setup(["banana", "purple"]);
  const ask = () => ctx.jarvis.requestApproval({ sessionId: 1, toolName: "Write", input: { file_path: "/Users/me/notes.md" } });

  const silent = ask();
  await tick();
  assert.equal(ctx.spoken.at(-1), "May I write notes.md?");
  ctx.jarvis.onNoSpeech();
  assert.equal((await silent).behavior, "deny");

  const unclear = ask();
  await tick();
  await ctx.jarvis.onUtterance(new Int16Array(16)); // "banana"
  await tick();
  assert.equal(ctx.spoken.at(-1), "Sorry, was that a yes or a no?");
  await ctx.jarvis.onUtterance(new Int16Array(16)); // "purple"
  const d = await unclear;
  assert.equal(d.behavior, "deny");
});

test("an approval can be answered on the orb", async () => {
  const ctx = setup([]);
  const decision = ctx.jarvis.requestApproval({ sessionId: 1, toolName: "Edit", input: { file_path: "/x/README.md" } });
  await tick();
  const asked = ctx.events.find((e) => e.type === "approval") as { id: number };
  ctx.jarvis.answerFromUi(asked.id, true);
  assert.equal((await decision).behavior, "allow");
});

test("tool use in the current turn carries a 'what Jarvis is doing' line", async () => {
  const ctx = setup(["Jarvis, find the flaky test"]);
  ctx.jarvis.activate(true);
  const reply = ctx.jarvis.onUtterance(new Int16Array(16));
  await tick();
  ctx.claude.turns[0].handlers.onTool!("Grep", { pattern: "flaky" });
  const tool = ctx.events.find((e) => e.type === "tool") as Extract<UiEvent, { type: "tool" }>;
  assert.equal(tool.activity, "Searching for “flaky”");
  ctx.claude.turns[0].finish({});
  await reply;
});

test("a destructive command can't be approved by voice: it needs a click", async () => {
  const ctx = setup(["yes", "yes"]);
  const decision = ctx.jarvis.requestApproval({ sessionId: 1, toolName: "Bash",
    input: { command: "git push origin main", description: "Push the branch to GitHub" } });
  await tick();
  const asked = ctx.events.find((e) => e.type === "approval") as Extract<UiEvent, { type: "approval" }>;
  assert.equal(asked.destructive, true);
  await ctx.jarvis.onUtterance(new Int16Array(16)); // "yes"
  await tick();
  assert.equal(ctx.spoken.at(-1), "That one can't be undone, so please click Allow if you're sure.");
  assert.equal(ctx.jarvis.state, "asking", "still waiting");
  ctx.jarvis.answerFromUi(asked.id, true);
  assert.equal((await decision).behavior, "allow");
});

// --- Agents window: tasks started, steered and stopped without voice ---

const lastTask = (events: UiEvent[], id?: number) =>
  events.filter((e) => e.type === "task" && (id === undefined || e.id === id)).at(-1) as Extract<UiEvent, { type: "task" }>;

test("'New task…' runs in the background in the chosen project and reports back", async () => {
  const ctx = setup([]);
  const id = ctx.jarvis.startTask("Summarise the open issues", "payments platform")!;
  await tick();
  assert.equal(ctx.claudeStarts.at(-1)!.cwd, join(ctx.projectsDir, "payments-platform"));
  assert.equal(ctx.claude.turns[0].text, "Summarise the open issues");
  const started = lastTask(ctx.events, id);
  assert.equal(started.status, "running");
  assert.equal(started.origin, "window");
  assert.equal(started.request, "Summarise the open issues");

  ctx.claude.turns[0].handlers.onTool!("WebFetch", { url: "https://github.com/x/y/issues" });
  const step = ctx.events.find((e) => e.type === "task_step") as Extract<UiEvent, { type: "task_step" }>;
  assert.deepEqual([step.taskId, step.tool, step.detail], [id, "WebFetch", "Reading github.com"]);

  ctx.claude.turns[0].handlers.onText!("Three issues matter.");
  ctx.claude.turns[0].finish({ text: "Three issues matter.", sessionId: "claude-issues" });
  await tick();
  await tick();
  assert.equal(lastTask(ctx.events, id).status, "done");
  assert.equal(lastTask(ctx.events, id).claudeSessionId, "claude-issues", "for Copy resume command");
  assert.ok(ctx.events.some((e) => e.type === "task_report" && e.taskId === id));
});

test("a fourth task waits for a free slot, then starts", async () => {
  const ctx = setup([]);
  const ids = ["one", "two", "three", "four"].map((t) => ctx.jarvis.startTask(`task ${t}`)!);
  await tick();
  assert.equal(ctx.claude.turns.length, 3);
  assert.equal(lastTask(ctx.events, ids[3]).status, "queued");
  ctx.claude.turns[0].finish({ text: "done" });
  await tick();
  await tick();
  assert.equal(ctx.claude.turns.length, 4);
  assert.equal(ctx.claude.turns[3].text, "task four");
  assert.equal(lastTask(ctx.events, ids[3]).status, "running");
});

test("a note to a running task interrupts it and carries on with the note", async () => {
  const ctx = setup([]);
  const id = ctx.jarvis.startTask("Fix the flaky test")!;
  await tick();
  ctx.jarvis.noteTask(id, "skip the e2e tests");
  assert.equal(ctx.claude.interrupts(), 1);
  await tick();
  await tick();
  assert.equal(ctx.claude.turns.length, 2);
  assert.match(ctx.claude.turns[1].text, /skip the e2e tests/);
  assert.equal(lastTask(ctx.events, id).status, "running");
  assert.equal(ctx.events.filter((e) => e.type === "task_report").length, 0, "not reported as finished");
});

test("stopping a task ends it without a report", async () => {
  const ctx = setup([]);
  const id = ctx.jarvis.startTask("Refactor everything")!;
  await tick();
  ctx.jarvis.stopTask(id);
  await tick();
  await tick();
  assert.equal(lastTask(ctx.events, id).status, "stopped");
  assert.equal(ctx.events.filter((e) => e.type === "task_report").length, 0);
  assert.equal(ctx.sounds.filter((s) => s === "done").length, 0);
});

test("a note to a finished task asks a follow-up in the same conversation", async () => {
  const ctx = setup([]);
  const id = ctx.jarvis.startTask("Add search")!;
  await tick();
  ctx.claude.turns[0].finish({ text: "Added search.", sessionId: "claude-search" });
  await tick();
  await tick();
  ctx.jarvis.noteTask(id, "add a test for the empty search");
  await tick();
  assert.equal(ctx.claudeStarts.at(-1)!.resume, "claude-search");
  assert.equal(ctx.claude.turns[1].text, "add a test for the empty search");
  assert.equal(lastTask(ctx.events, id).status, "running");
  assert.equal(lastTask(ctx.events, id).reported, false);
});

test("History window: search lists past conversations, and Continue makes the next wake go there", async () => {
  const history = new HistoryStore(":memory:");
  const old = history.createSession("/tmp/jarvis-workspace", "jarvis-workspace", 1000);
  history.addTurn(old.id, "plan transport to Sepang", "Take the train", [], 1000);
  history.update(old.id, { title: "Sepang trip", claudeSessionId: "claude-old" });
  const { jarvis, events, claudeStarts } = setup([], { history });
  jarvis.prepare();

  jarvis.historyQuery("sepang");
  const results = events.at(-1) as Extract<UiEvent, { type: "history_results" }>;
  assert.deepEqual(results.sessions.map((s) => [s.title, s.current]), [["Sepang trip", false]]);
  assert.deepEqual(results.projects, ["jarvis-workspace"]);

  jarvis.historyOpen(old.id);
  assert.deepEqual((events.at(-1) as Extract<UiEvent, { type: "history_detail" }>).turns.map((t) => t.reply), ["Take the train"]);

  jarvis.historyContinue(old.id);
  assert.equal(claudeStarts.at(-1)!.resume, "claude-old");
  assert.match((events.at(-1) as { text: string }).text, /Sepang trip/);
  jarvis.historyQuery("");
  assert.equal((events.at(-1) as Extract<UiEvent, { type: "history_results" }>).sessions[0].current, true);
});

test("'Always allow' saves a rule for that folder: the next matching request isn't asked", async () => {
  const ctx = setup([]);
  ctx.jarvis.prepare(); // session 1 in /tmp/jarvis-workspace
  const first = ctx.jarvis.requestApproval({ sessionId: 1, toolName: "Bash", input: { command: "npm test" } });
  await tick();
  const asked = ctx.events.find((e) => e.type === "approval") as Extract<UiEvent, { type: "approval" }>;
  assert.equal(asked.always, "Run “npm test” in jarvis-workspace");
  ctx.jarvis.answerFromUi(asked.id, true, true);
  assert.equal((await first).behavior, "allow");
  assert.deepEqual((ctx.events.findLast((e) => e.type === "rules") as Extract<UiEvent, { type: "rules" }>).rules,
    [{ label: "Run “npm test”", folder: "/tmp/jarvis-workspace" }]);

  const asks = ctx.events.filter((e) => e.type === "approval").length;
  assert.equal((await ctx.jarvis.requestApproval({ sessionId: 1, toolName: "Bash", input: { command: "npm test -- x" } })).behavior, "allow");
  assert.equal(ctx.events.filter((e) => e.type === "approval").length, asks, "not asked again");

  const push = ctx.jarvis.requestApproval({ sessionId: 1, toolName: "Bash", input: { command: "git push" } });
  await tick();
  assert.equal((ctx.events.at(-1) as Extract<UiEvent, { type: "approval" }>).always, undefined, "never offered for destructive commands");
  ctx.jarvis.stop();
  assert.equal((await push).behavior, "deny");
});

test("a task's report lists the files it changed, with the diff", async () => {
  const { mkdtempSync: mk, writeFileSync } = await import("node:fs");
  const ctx = setup([]);
  const dir = mk(join(tmpdir(), "jarvis-task-"));
  writeFileSync(join(dir, "a.txt"), "old\n");
  const id = ctx.jarvis.startTask("Update a.txt");
  await tick();
  ctx.claude.turns[0].handlers.onTool!("Edit", { file_path: join(dir, "a.txt"), old_string: "old", new_string: "new" });
  writeFileSync(join(dir, "a.txt"), "new\n");
  ctx.claude.turns[0].finish({ text: "Updated it." });
  await tick();
  await tick();
  const report = ctx.events.find((e) => e.type === "task_report" && e.taskId === id) as Extract<UiEvent, { type: "task_report" }>;
  assert.deepEqual(report.files, [{ path: join(dir, "a.txt"), added: 1, removed: 1 }]);
  assert.match(report.diff, /-old\n\+new/);
  ctx.jarvis.activate(true);
  await tick();
  assert.match(ctx.spoken.join(" "), /1 file changed\./);
});
