import assert from "node:assert/strict";
import { test } from "node:test";
import { Listener, level, type VadModel, type WakeModel } from "../src/listener.ts";

// Fakes: "speech" is any frame whose samples are non-zero; the wake word fires on
// the chunk where samples equal WAKE.
const WAKE = 7;
const fakeWake = (): WakeModel => ({
  process: async (chunk) => (chunk[0] === WAKE ? 0.9 : 0.01),
  reset() {},
});
const fakeVad = (): VadModel => ({
  process: async (frame) => (frame.some((s) => s !== 0) ? 0.9 : 0.05),
  reset() {},
});

const ms = (n: number, value = 0) => new Int16Array(16 * n).fill(value);

function setup() {
  const events: string[] = [];
  let utterance: Int16Array | undefined;
  const listener = new Listener(fakeWake(), fakeVad(), {
    onWake: () => events.push("wake"),
    onSpeechStart: () => events.push("speech"),
    onUtterance: (pcm) => {
      events.push("utterance");
      utterance = pcm;
    },
    onNoSpeech: () => events.push("no-speech"),
    onBargeIn: () => events.push("barge-in"),
  });
  return { listener, events, utterance: () => utterance };
}

test("fires the wake word once, then honours the cooldown", async () => {
  const { listener, events } = setup();
  await listener.feed(ms(160));
  await listener.feed(ms(80, WAKE));
  await listener.feed(ms(80, WAKE));
  assert.deepEqual(events, ["wake"]);
});

test("ends an utterance after 700 ms of silence and includes the pre-roll", async () => {
  const { listener, events, utterance } = setup();
  await listener.feed(ms(500, 1)); // audio before capture ("Hey Jarvis")
  listener.startCapture({ preRollMs: 300, noSpeechTimeoutMs: 5000 });
  await listener.feed(ms(1000, 100)); // speech
  await listener.feed(ms(600)); // not yet long enough
  assert.deepEqual(events, ["speech"]);
  await listener.feed(ms(200));
  assert.deepEqual(events, ["speech", "utterance"]);
  assert.equal(listener.capturing, false);
  const samples = utterance()!;
  assert.equal(samples[0], 1, "starts with pre-roll audio");
  assert.ok(samples.length >= 16 * (300 + 1000 + 700));
});

test("a pause shorter than the end silence doesn't split the utterance", async () => {
  const { listener, events } = setup();
  listener.startCapture({ preRollMs: 0, noSpeechTimeoutMs: 5000 });
  await listener.feed(ms(500, 100));
  await listener.feed(ms(500));
  await listener.feed(ms(500, 100));
  await listener.feed(ms(800));
  assert.deepEqual(events, ["speech", "utterance"]);
});

test("gives up when nobody speaks", async () => {
  const { listener, events } = setup();
  listener.startCapture({ preRollMs: 0, noSpeechTimeoutMs: 1000 });
  await listener.feed(ms(1100));
  assert.deepEqual(events, ["no-speech"]);
  assert.equal(listener.capturing, false);
});

test("ignores a click shorter than the minimum speech length", async () => {
  const { listener, events } = setup();
  listener.startCapture({ preRollMs: 0, noSpeechTimeoutMs: 1000 });
  await listener.feed(ms(40, 100));
  await listener.feed(ms(1100));
  assert.deepEqual(events, ["no-speech"]);
});

test("maps loudness onto 0..1", () => {
  assert.equal(level(ms(10)), 0);
  assert.ok(level(ms(10, 32767)) > 0.999);
  assert.ok(Math.abs(level(ms(10, 328)) - 0.33) < 0.02); // about -40 dBFS
});

test("while watching, ~128 ms of speech in a 400 ms window is a barge-in; echo blips are not", async () => {
  const { listener, events } = setup();
  listener.watchForSpeech(true);
  await listener.feed(ms(64, 100)); // the longest leftover echo measured
  await listener.feed(ms(500));
  assert.deepEqual(events, []);
  // "stop" with a dip in the middle still counts
  await listener.feed(ms(96, 100));
  await listener.feed(ms(64));
  await listener.feed(ms(64, 100));
  assert.deepEqual(events, ["barge-in"]);
  await listener.feed(ms(400, 100));
  assert.deepEqual(events, ["barge-in"], "fires once, then stops watching");
});

test("reports how close speech came when watching ends without a barge-in", async () => {
  const peaks: number[] = [];
  const listener = new Listener(fakeWake(), fakeVad(), { onWatchEnd: (ms) => peaks.push(ms) });
  listener.watchForSpeech(true);
  await listener.feed(ms(96, 100));
  await listener.feed(ms(500));
  listener.watchForSpeech(false);
  assert.deepEqual(peaks, [96]);
});

test("a capture that starts mid-speech ends on the next silence", async () => {
  const { listener, events } = setup();
  listener.startCapture({ preRollMs: 800, noSpeechTimeoutMs: 3000, speechStarted: true });
  await listener.feed(ms(800));
  assert.deepEqual(events, ["utterance"]);
});
