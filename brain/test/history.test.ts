import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRequest, parseAnswer } from "../src/approvals.ts";
import { parseCommand } from "../src/commands.ts";
import { HistoryStore, keywords } from "../src/history.ts";

test("stores sessions and turns; recent skips sessions never used", () => {
  const h = new HistoryStore(":memory:");
  const a = h.createSession("/w", "w", 1000);
  h.createSession("/w", "w", 2000); // empty
  h.addTurn(a.id, "hello", "hi there", ["Bash ls"], 3000);
  h.update(a.id, { title: "Greetings", claudeSessionId: "abc" });
  const [only, ...rest] = h.recent();
  assert.equal(rest.length, 0);
  assert.equal(only.title, "Greetings");
  assert.equal(only.turns, 1);
  assert.equal(only.lastActiveAt, 3000);
  assert.deepEqual(h.transcript(a.id)[0].tools, ["Bash ls"]);
});

test("finds sessions by title, project and what was said", () => {
  const h = new HistoryStore(":memory:");
  const voice = h.createSession("/w", "jarvis-ai");
  h.addTurn(voice.id, "which kokoro voice sounds best", "George sounds most like Jarvis", []);
  h.update(voice.id, { title: "Choosing the Kokoro voice" });
  const trip = h.createSession("/w", "workspace");
  h.addTurn(trip.id, "plan transport to Sepang", "Take the KLIA Ekspres, then a shuttle", []);
  assert.equal(h.findSessions("the kokoro voice")[0].session.id, voice.id);
  assert.equal(h.findSessions("sepang trip")[0].session.id, trip.id);
  assert.deepEqual(h.findSessions("quantum physics"), []);
  assert.equal(h.searchTurns("what did we decide about sepang")[0].turn.reply, "Take the KLIA Ekspres, then a shuttle");
});

test("keywords drop filler words", () => {
  assert.deepEqual(keywords("What did we decide about the Kokoro voice?"), ["kokoro", "voice"]);
});

test("parses session commands", () => {
  const cases: Array<[string, ReturnType<typeof parseCommand>]> = [
    ["New session.", { kind: "new" }],
    ["Let's start over", { kind: "new" }],
    ["Go back to the auth refactor.", { kind: "resume", query: "auth refactor" }],
    ["Continue our conversation about the voice", { kind: "resume", query: "conversation about the voice" }],
    ["Switch to the payments platform project.", { kind: "project", name: "payments platform" }],
    ["Open the jarvis AI repo", { kind: "project", name: "jarvis AI" }],
    ["What did we decide about the voice?", { kind: "recall", query: "the voice" }],
    ["Remind me what we said about Sepang", { kind: "recall", query: "Sepang" }],
    ["What have we been working on?", { kind: "list" }],
    ["Keep going in the background", { kind: "background" }],
    ["Okay, do that in the background.", { kind: "background" }],
    ["What time is it?", { kind: "none" }],
    ["Switch the tests to Vitest", { kind: "none" }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseCommand(text), expected, text);
});

test("phrases permission requests for speech and reads yes/no answers", () => {
  assert.deepEqual(describeRequest({ sessionId: 1, toolName: "Bash", input: { command: "git commit -m x", description: "Commit the changes." } }),
    { question: "May I commit the changes?", detail: "git commit -m x" });
  assert.equal(describeRequest({ sessionId: 1, toolName: "WebFetch", input: { url: "https://f1.com/calendar" } }).question, "May I open f1.com?");
  for (const t of ["Yes.", "Yeah, go ahead", "Hey Jarvis, do it", "Sure"]) assert.equal(parseAnswer(t), "yes", t);
  for (const t of ["No.", "Nope", "Don't do that", "No, okay, don't"]) assert.equal(parseAnswer(t), "no", t);
  assert.equal(parseAnswer("What does it do?"), undefined);
});
