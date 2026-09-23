import assert from "node:assert/strict";
import { test } from "node:test";
import { SentenceSplitter, speakable } from "../src/sentences.ts";
import { measure } from "../src/recorder.ts";
import { cleanTranscript } from "../src/transcriber.ts";

function feed(chunks: string[]): string[] {
  const splitter = new SentenceSplitter();
  const out = chunks.flatMap((c) => splitter.push(c));
  return [...out, ...splitter.flush()];
}

test("emits a sentence only once the following whitespace arrives", () => {
  const splitter = new SentenceSplitter();
  assert.deepEqual(splitter.push("Hello there."), []);
  assert.deepEqual(splitter.push(" How"), ["Hello there."]);
  assert.deepEqual(splitter.flush(), ["How"]);
});

test("keeps decimals together", () => {
  assert.deepEqual(feed(["Version 3.", "5 is out. Try it"]), ["Version 3.5 is out.", "Try it"]);
});

test("splits on line breaks", () => {
  assert.deepEqual(feed(["First line\nSecond line"]), ["First line", "Second line"]);
});

test("drops code fences, even when the fence arrives in pieces", () => {
  assert.deepEqual(
    feed(["Here it is:\n`", "``ts\nconst x = 1.", " y = 2;\n``", "`\nI've put it on screen."]),
    ["Here it is:", "I've put it on screen."],
  );
});

test("drops an unterminated code fence at end of turn", () => {
  assert.deepEqual(feed(["Done.\n```\nrm -rf build"]), ["Done."]);
});

test("strips markdown for speech", () => {
  assert.equal(speakable("## **Bold** move"), "Bold move");
  assert.equal(speakable("- see [the docs](https://x.dev) and `npm test`"), "see the docs and npm test");
  assert.equal(speakable("---"), "");
});

test("cleans whisper noise tags", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO] "), "");
  assert.equal(cleanTranscript(" (keyboard clicking) Hey Jarvis, hello\n"), "Hey Jarvis, hello");
});

test("measures speech in recorded audio", () => {
  const silence = Buffer.alloc(16_000 * 2); // 1 s of zeros
  assert.deepEqual(measure(silence), { durationMs: 1000, speechMs: 0, peakDbfs: -90 });

  const tone = Buffer.alloc(16_000); // 0.5 s, 440 Hz at half scale
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(16_384 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  const result = measure(Buffer.concat([silence, tone]));
  assert.equal(result.durationMs, 1500);
  assert.equal(result.peakDbfs, -6);
  assert.ok(result.speechMs >= 480 && result.speechMs <= 510, `speechMs ${result.speechMs}`);
});
