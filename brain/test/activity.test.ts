import assert from "node:assert/strict";
import { test } from "node:test";
import { isDestructive } from "../src/approvals.ts";
import { describeActivity } from "../src/activity.ts";

test("turns tool calls into a short 'what Jarvis is doing' line", () => {
  assert.equal(describeActivity("Read", { file_path: "/Users/me/jarvis-ai/brain/test/listener.test.ts" }), "Reading listener.test.ts");
  assert.equal(describeActivity("Edit", { file_path: "/x/src/listener.ts" }), "Editing listener.ts");
  assert.equal(describeActivity("Write", { file_path: "/x/notes.md" }), "Writing notes.md");
  assert.equal(describeActivity("Grep", { pattern: "TODO" }), "Searching for “TODO”");
  assert.equal(describeActivity("Glob", { pattern: "**/*.ts" }), "Looking for files");
  assert.equal(describeActivity("Bash", { command: "npm test", description: "Run the test suite" }), "Run the test suite");
  assert.equal(describeActivity("Bash", { command: "git status" }), "Running git status");
  assert.equal(describeActivity("WebSearch", { query: "F1 calendar 2026" }), "Searching the web for F1 calendar 2026");
  assert.equal(describeActivity("WebFetch", { url: "https://www.formula1.com/en/racing" }), "Reading www.formula1.com");
  assert.equal(describeActivity("TodoWrite", {}), "Planning the steps");
  assert.equal(describeActivity("mcp__github__list_repos", {}), "Using list_repos");
});

test("flags commands that can't be undone, which need a click", () => {
  const bash = (command: string) => ({ sessionId: 1, toolName: "Bash", input: { command } });
  for (const c of ["rm -rf build", "rm -r old", "git push origin main", "git reset --hard HEAD~1", "git clean -fd",
    "sudo rm /x", "git branch -D feature", "npm publish", "git push --force"]) {
    assert.equal(isDestructive(bash(c)), true, c);
  }
  for (const c of ["npm test", "git status", "git commit -m 'x'", "rm notes.tmp", "ls -la", "git log --oneline"]) {
    assert.equal(isDestructive(bash(c)), false, c);
  }
  assert.equal(isDestructive({ sessionId: 1, toolName: "Edit", input: { file_path: "/x" } }), false);
});
