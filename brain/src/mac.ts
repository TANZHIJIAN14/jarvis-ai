import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toWav } from "./recorder.ts";

// The bits of Settings and first-run setup that touch the Mac: open at login, the claude
// sign-in check, and the 7-day recordings.

// --- Open at login: a LaunchAgent that starts the brain (which starts the UI) when you log in.

const AGENT = join(homedir(), "Library/LaunchAgents/ai.jarvis.brain.plist");

export function isOpenAtLogin(): boolean {
  return existsSync(AGENT);
}

export function setOpenAtLogin(on: boolean, run: { args: string[]; cwd: string; log: string }): void {
  if (!on) {
    if (existsSync(AGENT)) unlinkSync(AGENT);
    return;
  }
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(AGENT, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.jarvis.brain</string>
  <key>ProgramArguments</key>
  <array>
${run.args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(run.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(run.log)}</string>
  <key>StandardErrorPath</key><string>${xml(run.log)}</string>
</dict>
</plist>
`);
}

// --- Claude Code: installed, signed in, which plan. Never exposes the account's email.

export type ClaudeStatus = { installed: boolean; version?: string; loggedIn: boolean; plan?: string };

export async function claudeStatus(): Promise<ClaudeStatus> {
  const run = (args: string[]) => new Promise<string | undefined>((resolve) => {
    execFile("claude", args, { timeout: 20_000 }, (err, stdout) => resolve(err && !stdout ? undefined : stdout));
  });
  const version = (await run(["--version"]))?.trim().split(" ")[0];
  if (!version) return { installed: false, loggedIn: false };
  try {
    const auth = JSON.parse((await run(["auth", "status", "--json"])) ?? "{}") as { loggedIn?: boolean; subscriptionType?: string };
    return { installed: true, version, loggedIn: Boolean(auth.loggedIn), plan: auth.subscriptionType };
  } catch {
    return { installed: true, version, loggedIn: false };
  }
}

// --- Recordings: what the mic heard for each request, kept 7 days when turned on.

const WEEK_MS = 7 * 86_400_000;

export function saveRecording(dir: string, pcm: Int16Array, now = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${new Date(now).toISOString().replace(/[:.]/g, "-")}.wav`),
    toWav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
  pruneRecordings(dir, now);
}

export function pruneRecordings(dir: string, now = Date.now()): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (now - statSync(path).mtimeMs > WEEK_MS) unlinkSync(path);
  }
}

export function clearRecordings(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
