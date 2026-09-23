import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Built from native/speak.swift (npm run build:native).
const SPEAK = fileURLToPath(new URL("../../native/bin/speak", import.meta.url));

// Speaks sentences back to back through one long-lived native speech process.
// Milestone 2 swaps the voice for Kokoro behind the same methods.
export class Speaker {
  private proc: ChildProcess | undefined;
  private args: string[];
  private busy = false;
  private waiters: Array<() => void> = [];
  onFirstAudio: (() => void) | undefined;

  // speed: 1.0 = the system's normal speaking rate.
  constructor(opts: { voice?: string; speed?: number } = {}) {
    this.args = [];
    if (opts.voice) this.args.push("--voice", opts.voice);
    if (opts.speed) this.args.push("--speed", String(opts.speed));
  }

  say(sentence: string): void {
    this.busy = true;
    this.send(`say ${sentence.replace(/\s+/g, " ")}`);
  }

  // Barge-in: drop everything queued and cut the current sentence off.
  stop(): void {
    if (this.busy) this.send("stop");
  }

  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.proc?.stdin?.end();
  }

  private send(command: string): void {
    this.ensureRunning().stdin!.write(command + "\n");
  }

  private ensureRunning(): ChildProcess {
    if (this.proc) return this.proc;
    if (!existsSync(SPEAK)) throw new Error("speak is not built; run npm run build:native");
    const proc = spawn(SPEAK, this.args, { stdio: ["pipe", "pipe", "ignore"] });
    this.proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (event) => {
      if (event === "start") {
        this.onFirstAudio?.();
        this.onFirstAudio = undefined;
      } else if (event === "idle") {
        this.settle();
      }
    });
    proc.on("exit", () => {
      this.proc = undefined;
      this.settle();
    });
    return proc;
  }

  private settle(): void {
    this.busy = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
