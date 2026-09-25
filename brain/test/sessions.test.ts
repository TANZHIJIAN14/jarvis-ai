import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClaudeSession } from "../src/claude-session.ts";
import { HistoryStore } from "../src/history.ts";
import { SessionManager } from "../src/sessions.ts";

function setup() {
  let now = 1_000_000;
  const started: Array<{ cwd: string; resume?: string }> = [];
  const closed: number[] = [];
  const asks: string[] = [];
  const history = new HistoryStore(":memory:");
  const projectsDir = mkdtempSync(join(tmpdir(), "jarvis-projects-"));
  for (const name of ["jarvis-ai", "payments-platform", "Personal portfolio"]) mkdirSync(join(projectsDir, name));
  const sessions = new SessionManager({
    history,
    newClaude: (o) => {
      started.push(o);
      const n = started.length;
      return { warm() {}, close: () => closed.push(n) } as unknown as ClaudeSession;
    },
    ask: async (instruction) => {
      asks.push(instruction);
      return instruction.startsWith("Give") ? "Planning the Sepang trip" : "They planned transport to Sepang.";
    },
    defaultCwd: "/w",
    projectsDir,
    now: () => now,
  });
  return { sessions, history, started, closed, asks, projectsDir, advance: (ms: number) => (now += ms) };
}

test("continues within 10 minutes, starts fresh after", () => {
  const { sessions, started, advance } = setup();
  sessions.forTurn();
  sessions.recordTurn("hi", "hello", [], "c1");
  advance(9 * 60_000);
  sessions.forTurn();
  assert.equal(started.length, 1);
  advance(2 * 60_000);
  sessions.forTurn();
  assert.equal(started.length, 2);
});

test("titles a session after its first turn and summarises it when moving on", async () => {
  const { sessions, history, asks } = setup();
  sessions.forTurn();
  sessions.recordTurn("plan transport to Sepang", "Take the train", [], "c1");
  await sessions.settle();
  assert.equal(history.recent()[0].title, "Planning the Sepang trip");
  sessions.startNew();
  await sessions.settle();
  assert.equal(history.recent()[0].summary, "They planned transport to Sepang.");
  assert.equal(asks.length, 2);
});

test("resumes the Claude conversation of a past session", () => {
  const { sessions, started, closed } = setup();
  sessions.forTurn();
  sessions.recordTurn("plan transport to Sepang", "Take the train", [], "claude-abc");
  sessions.startNew();
  const found = sessions.findSession("the sepang transport");
  assert.ok(found);
  sessions.resume(found);
  assert.deepEqual(started.at(-1), { cwd: "/w", resume: "claude-abc" });
  assert.deepEqual(closed, [1, 2]);
  assert.equal(sessions.findSession("sepang"), undefined, "the current session is not a resume target");
});

test("finds project folders from how they're said", () => {
  const { sessions, projectsDir } = setup();
  assert.equal(sessions.findProject("payments platform"), join(projectsDir, "payments-platform"));
  assert.equal(sessions.findProject("Jarvis AI"), join(projectsDir, "jarvis-ai"));
  assert.equal(sessions.findProject("personal portfolio"), join(projectsDir, "Personal portfolio"));
  assert.equal(sessions.findProject("kubernetes"), undefined);
});
