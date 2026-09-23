import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeSession, TurnHandlers, TurnResult } from "../src/claude-session.ts";
import { Jarvis, stripWakePhrase, type UiEvent } from "../src/jarvis.ts";
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

function setup(transcripts: string[]) {
  const events: UiEvent[] = [];
  const captures: CaptureOptions[] = [];
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
  const jarvis = new Jarvis({
    listener: { startCapture: (o: CaptureOptions) => captures.push(o), stopCapture() {} } as unknown as Listener,
    transcriber: { transcribePcm: async () => transcripts.shift() ?? "" } as unknown as Transcriber,
    speaker: speaker as unknown as Speaker,
    newSession: () => claude.session,
    emit: (e) => events.push(e),
    chime: () => {},
  });
  const states = () => events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state);
  return { jarvis, events, captures, spoken, claude, states };
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
