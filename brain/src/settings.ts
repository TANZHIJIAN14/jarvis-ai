import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// What the Settings window changes. Saved in the data folder; a JARVIS_* environment variable
// still wins over the file, and the window shows that setting as locked.

export type Settings = {
  voice: string; // a Kokoro voice id (bm_george) or an Apple system voice name (samantha)
  voiceSpeed: number;
  sir: boolean; // "Call me sir"
  wakeThreshold: number; // 0.3 wakes easily .. 0.8 strict
  talkOver: boolean; // interrupt by talking (echo cancellation)
  pushToTalk: boolean; // hold F5 to talk
  maxTasks: number; // background tasks at once
  model: string; // "" = the claude CLI's default
  openAtLogin: boolean;
  keepRecordings: boolean; // 7 days, to check transcription mistakes
  projects: string[]; // folders added in Settings, besides those under ~/Documents
  onboarded: boolean; // first-run setup finished
};

export const VOICES = [
  { id: "bm_george", name: "George", note: "British, calm and low · default" },
  { id: "bm_daniel", name: "Daniel", note: "British, brighter" },
  { id: "bm_lewis", name: "Lewis", note: "British, deeper" },
  { id: "bm_fable", name: "Fable", note: "British, storyteller" },
  { id: "am_michael", name: "Michael", note: "American" },
  { id: "samantha", name: "Samantha", note: "Apple system voice, no download" },
];
export const MODELS = ["", "sonnet", "haiku", "opus"];

// Settings an environment variable overrides.
const ENV: Partial<Record<keyof Settings, string[]>> = {
  voice: ["JARVIS_VOICE", "JARVIS_TTS"],
  voiceSpeed: ["JARVIS_VOICE_SPEED"],
  wakeThreshold: ["JARVIS_WAKE_THRESHOLD"],
  talkOver: ["JARVIS_ECHO_CANCEL"],
  model: ["JARVIS_MODEL"],
};

// Kokoro voice ids look like "bm_george"; anything else is an Apple voice.
export function isKokoroVoice(voice: string): boolean {
  return /^[a-z]{2}_[a-z]+$/.test(voice);
}

export class SettingsStore {
  values: Settings;
  readonly locked: Array<keyof Settings>;
  private path: string | undefined;

  // `defaults` already include the environment (config.ts); no path = in memory (tests).
  constructor(path: string | undefined, defaults: Settings, env: NodeJS.ProcessEnv = process.env) {
    this.path = path;
    this.locked = (Object.keys(ENV) as Array<keyof Settings>).filter((key) => ENV[key]!.some((name) => env[name] !== undefined));
    let saved: Partial<Settings> = {};
    if (path && existsSync(path)) {
      try {
        saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
      } catch {}
    }
    this.values = { ...defaults };
    this.apply(saved);
  }

  // Applies what's valid and not locked; returns the keys that changed.
  update(patch: Partial<Settings>): Array<keyof Settings> {
    const changed = this.apply(patch);
    if (changed.length > 0) this.save();
    return changed;
  }

  private apply(patch: Partial<Settings>): Array<keyof Settings> {
    const changed: Array<keyof Settings> = [];
    for (const [key, raw] of Object.entries(patch) as Array<[keyof Settings, unknown]>) {
      if (!(key in this.values) || this.locked.includes(key)) continue;
      const value = valid(key, raw);
      if (value === undefined || JSON.stringify(value) === JSON.stringify(this.values[key])) continue;
      (this.values as Record<string, unknown>)[key] = value;
      changed.push(key);
    }
    return changed;
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.values, null, 2));
  }
}

function valid(key: keyof Settings, value: unknown): unknown {
  const clamp = (lo: number, hi: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : undefined);
  switch (key) {
    case "voice":
      return typeof value === "string" && value ? value : undefined;
    case "voiceSpeed":
      return clamp(0.8, 1.2);
    case "wakeThreshold":
      return clamp(0.3, 0.8);
    case "maxTasks":
      return typeof value === "number" ? Math.round(clamp(1, 4) as number) : undefined;
    case "model":
      return typeof value === "string" && MODELS.includes(value) ? value : undefined;
    case "projects":
      return Array.isArray(value) && value.every((p) => typeof p === "string") ? [...new Set(value)] : undefined;
    default:
      return typeof value === "boolean" ? value : undefined;
  }
}
