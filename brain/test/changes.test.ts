import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChangeTracker } from "../src/changes.ts";
import { AllowRules, commandPrefix, ruleFor } from "../src/rules.ts";

test("reports files a task changed, with line counts and a diff; untouched or reverted files are left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-changes-"));
  writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "same.ts"), "x\n");
  writeFileSync(join(dir, "gone.ts"), "bye\n");
  const tracker = new ChangeTracker(dir);
  tracker.onTool("Edit", { file_path: join(dir, "a.ts"), old_string: "two", new_string: "2" });
  tracker.onTool("Edit", { file_path: join(dir, "same.ts") }); // denied: never changes
  tracker.onTool("Write", { file_path: "new.ts", content: "hi\n" });
  tracker.onTool("Bash", { command: "rm gone.ts" }); // not tracked
  tracker.onTool("Read", { file_path: join(dir, "gone.ts") });
  writeFileSync(join(dir, "a.ts"), "one\n2\nthree\n");
  writeFileSync(join(dir, "new.ts"), "hi\nthere\n");
  unlinkSync(join(dir, "gone.ts"));

  const { files, diff } = tracker.collect();
  assert.deepEqual(files, [{ path: "a.ts", added: 1, removed: 1 }, { path: "new.ts", added: 2, removed: 0 }]);
  assert.match(diff, /--- a\/a\.ts\n\+\+\+ b\/a\.ts/);
  assert.match(diff, /-two\n\+2/);
  assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/new\.ts/);
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "one\n2\nthree\n");
});

test("'Always allow' rules: command prefixes and edits, only inside their folder, never destructive", () => {
  const rules = new AllowRules();
  const bash = (command: string) => ({ sessionId: 1, toolName: "Bash", input: { command } });
  assert.equal(commandPrefix("npm test -- --watch"), "npm test");
  assert.equal(commandPrefix("ls -la src"), "ls");
  assert.equal(commandPrefix("npm test && git push"), undefined);
  assert.equal(ruleFor(bash("git push origin main"), "/p"), undefined, "destructive: no rule offered");

  rules.add(ruleFor(bash("npm test"), "/p/jarvis-ai")!);
  assert.ok(rules.allows(bash("npm test -- listener"), "/p/jarvis-ai"));
  assert.ok(rules.allows(bash("npm test"), "/p/jarvis-ai/brain"), "subfolders count");
  assert.ok(!rules.allows(bash("npm test"), "/p/other"));
  assert.ok(!rules.allows(bash("npm testing"), "/p/jarvis-ai"));
  assert.ok(!rules.allows(bash("npm test; rm -rf /"), "/p/jarvis-ai"));

  const edit = (file_path: string) => ({ sessionId: 1, toolName: "Edit", input: { file_path } });
  rules.add(ruleFor(edit("/p/jarvis-ai/a.ts"), "/p/jarvis-ai")!);
  assert.ok(rules.allows(edit("/p/jarvis-ai/src/b.ts"), "/p/jarvis-ai"));
  assert.ok(!rules.allows(edit("/etc/hosts"), "/p/jarvis-ai"), "files outside the folder still ask");
  rules.remove(0);
  assert.ok(!rules.allows(bash("npm test"), "/p/jarvis-ai"));
});

test("an edits rule made in the home folder covers only that file's folder", async () => {
  const { homedir } = await import("node:os");
  const home = homedir();
  const rules = new AllowRules();
  const edit = (file_path: string) => ({ sessionId: 1, toolName: "Edit", input: { file_path } });
  rules.add(ruleFor(edit(`${home}/notes/a.md`), home)!);
  assert.ok(rules.allows(edit(`${home}/notes/b.md`), home));
  assert.ok(!rules.allows(edit(`${home}/.zshrc`), home));
});
