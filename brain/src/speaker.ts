import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlink } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Built from native/speak.swift (npm run build:native).
const SPEAK = fileURLToPath(new URL("../../native/bin/speak", import.meta.url));

// Turns a sentence into a WAV file to play, e.g. KokoroVoice.synthesize.
export type Synthesize = (sentence: string) => Promise<string>;

// Speaks sentences back to back through one long-lived native audio process.
// With `synthesize`, each sentence is rendered by our own voice (Kokoro) while the previous
// one plays; without it, the system voice speaks the text directly.
export class Speaker {
  private proc: ChildProcess | undefined;
  private args: string[];
  private synthesize: Synthesize | undefined;
  private synthQueue: Promise<void> = Promise.resolve();
  private pendingSynth = 0;
  private gen = 0; // bumped by stop(); stale syntheses are dropped
  private playerBusy = false;
  private stopsInFlight = 0; // each stop is answered by exactly one "idle"
  private workAfterStop = false;
  private waiters: Array<() => void> = [];
  onFirstAudio: (() => void) | undefined;
  onError: ((err: Error) => void) | undefined;

  // speed: 1.0 = normal (applies to the system voice; Kokoro gets its own speed).
  constructor(opts: { voice?: string; speed?: number; synthesize?: Synthesize } = {}) {
    this.args = ["--delete-played"];
    if (opts.voice) this.args.push("--voice", opts.voice);
    if (opts.speed) this.args.push("--speed", String(opts.speed));
    this.synthesize = opts.synthesize;
  }

  // Start the audio helper ahead of the first reply (it warms up the audio device).
  warm(): void {
    this.ensureRunning();
  }

  say(sentence: string): void {
    const text = sentence.replace(/\s+/g, " ");
    const synthesize = this.synthesize;
    if (!synthesize) {
      this.send(`say ${text}`);
      return;
    }
    const gen = this.gen;
    this.pendingSynth++;
    this.synthQueue = this.synthQueue.then(async () => {
      if (gen !== this.gen) return;
      try {
        const file = await synthesize(text);
        if (gen === this.gen) this.send(`play ${file}`);
        else unlink(file, () => {});
      } catch (err) {
        this.onError?.(err as Error);
      } finally {
        if (gen === this.gen) {
          this.pendingSynth--;
          this.maybeSettle();
        }
      }
    });
  }

  // Barge-in: drop everything queued and cut the current sentence off.
  stop(): void {
    this.gen++;
    this.pendingSynth = 0;
    if (this.playerBusy) {
      this.stopsInFlight++;
      this.workAfterStop = false;
      this.ensureRunning().stdin!.write("stop\n");
    }
    this.maybeSettle();
  }

  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.proc?.stdin?.end();
  }

  private get busy(): boolean {
    return this.playerBusy || this.pendingSynth > 0;
  }

  private send(command: string): void {
    if (this.stopsInFlight > 0) this.workAfterStop = true;
    this.playerBusy = true;
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
        this.onPlayerIdle();
      }
    });
    proc.on("exit", () => {
      this.proc = undefined;
      this.stopsInFlight = 0;
      this.playerBusy = false;
      this.maybeSettle();
    });
    return proc;
  }

  private onPlayerIdle(): void {
    if (this.stopsInFlight > 0) {
      this.stopsInFlight--;
      // This idle answers a stop; newer sentences may already be playing.
      if (this.workAfterStop) return;
    }
    this.playerBusy = false;
    this.maybeSettle();
  }

  private maybeSettle(): void {
    if (this.busy) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
