import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isKokoroVoice, SettingsStore, type Settings } from "../src/settings.ts";

const defaults: Settings = {
  voice: "bm_george", voiceSpeed: 1, sir: false, wakeThreshold: 0.5, talkOver: true, pushToTalk: false, maxTasks: 3, webWithoutAsking: true,
  model: "", openAtLogin: false, keepRecordings: false, projects: [], onboarded: false,
};

test("settings are saved, validated, and an environment variable locks its setting", () => {
  const path = join(mkdtempSync(join(tmpdir(), "jarvis-settings-")), "settings.json");
  const store = new SettingsStore(path, defaults, {});
  assert.deepEqual(store.update({ voice: "bm_daniel", voiceSpeed: 5, maxTasks: 2.4, model: "gpt", sir: true }),
    ["voice", "voiceSpeed", "maxTasks", "sir"]);
  assert.equal(store.values.voiceSpeed, 1.2, "clamped");
  assert.equal(store.values.maxTasks, 2);
  assert.equal(store.values.model, "", "unknown model ignored");
  assert.deepEqual(store.update({ sir: true }), [], "unchanged");

  const reloaded = new SettingsStore(path, defaults, { JARVIS_VOICE: "bm_lewis" });
  assert.equal(reloaded.values.sir, true);
  assert.deepEqual(reloaded.locked, ["voice"]);
  assert.equal(reloaded.values.voice, "bm_george", "the environment's value (in defaults) wins over the file");
  assert.deepEqual(reloaded.update({ voice: "bm_fable" }), []);
});

test("tells Kokoro voices from Apple ones", () => {
  assert.ok(isKokoroVoice("bm_george"));
  assert.ok(!isKokoroVoice("samantha"));
  assert.ok(!isKokoroVoice("Daniel"));
});
