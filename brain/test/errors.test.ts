import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClaudeError, CRASHED, NOT_INSTALLED } from "../src/errors.ts";

test("classifies Claude failures: unreachable (red Error), usage limit, or other", () => {
  assert.deepEqual(classifyClaudeError("Invalid API key · Please run /login"), { kind: "unreachable", reason: "signed_out" });
  assert.deepEqual(classifyClaudeError("OAuth token has expired"), { kind: "unreachable", reason: "signed_out" });
  assert.deepEqual(classifyClaudeError(NOT_INSTALLED), { kind: "unreachable", reason: "not_installed" });
  assert.deepEqual(classifyClaudeError(CRASHED), { kind: "unreachable", reason: "crashed" });
  assert.deepEqual(classifyClaudeError("API Error: Connection error. (ECONNREFUSED)"), { kind: "unreachable", reason: "offline" });
  assert.deepEqual(classifyClaudeError("Tool failed: file too large"), { kind: "other" });

  const noon = new Date(2026, 8, 28, 12, 0).getTime();
  const pm = classifyClaudeError("5-hour limit reached ∙ resets 3pm", noon);
  assert.equal(pm.kind, "limit");
  assert.equal((pm as { resetAt: number }).resetAt, new Date(2026, 8, 28, 15, 0).getTime());
  assert.equal((pm as { resetText: string }).resetText, "3 PM");
  const tomorrow = classifyClaudeError("You've hit your limit · resets 9:30am", noon) as { resetAt: number };
  assert.equal(tomorrow.resetAt, new Date(2026, 8, 29, 9, 30).getTime());
  const epoch = classifyClaudeError("Claude AI usage limit reached|1790604000", noon) as { resetAt: number };
  assert.equal(epoch.resetAt, 1790604000 * 1000);
  assert.deepEqual(classifyClaudeError("Claude usage limit reached"), { kind: "limit" });
});
