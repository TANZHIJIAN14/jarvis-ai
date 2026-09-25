import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { MIC_CAPTURE } from "./recorder.ts";

const FIRST_AUDIO_TIMEOUT_MS = 4000; // echo-cancelled capture normally starts in ~1.3 s
const STALL_MS = 2000; // the helper delivers ~85 ms chunks; 2 s of nothing is a stall
const ECHO_CANCEL_ATTEMPTS = 2; // then fall back to plain capture

// Continuous 16 kHz mono mic audio from the mic-capture helper, as Int16 sample chunks.
//
// Sometimes macOS starts the helper's audio engine but never runs its I/O thread, so no audio
// ever arrives (seen at startup, and while Jarvis was speaking). A watchdog restarts the helper
// when audio doesn't start or stops; after repeated failures with echo cancellation it falls
// back to plain capture so Jarvis keeps working.
export class MicStream {
  private proc: ChildProcess | undefined;
  private leftover: Buffer | undefined; // a pipe read can end mid-sample
  private onSamples: (samples: Int16Array) => void;
  private echoCancel: boolean;
  private stopping = false;
  private lastAudioAt = 0;
  private restarting = false;
  private watchdog: NodeJS.Timeout | undefined;
  onRestart: ((reason: string) => void) | undefined;

  constructor(onSamples: (samples: Int16Array) => void, opts: { echoCancel?: boolean } = {}) {
    this.onSamples = onSamples;
    this.echoCancel = opts.echoCancel ?? false;
  }

  // False once capture has fallen back from echo cancellation.
  get echoCancelling(): boolean {
    return this.echoCancel;
  }

  // Resolves once audio is flowing.
  async start(): Promise<void> {
    if (!existsSync(MIC_CAPTURE)) throw new Error("mic-capture is not built; run npm run build:native");
    for (let attempt = 1; !(await this.launch()); attempt++) {
      if (this.echoCancel && attempt >= ECHO_CANCEL_ATTEMPTS) {
        this.echoCancel = false;
        this.onRestart?.("no audio with echo cancellation; falling back to plain capture");
      } else if (attempt >= ECHO_CANCEL_ATTEMPTS + 2) {
        throw new Error("the microphone delivers no audio; check System Settings → Privacy & Security → Microphone");
      } else {
        this.onRestart?.("no audio from the microphone yet; restarting it");
      }
    }
    this.watchdog = setInterval(() => {
      if (this.stopping || this.restarting || Date.now() - this.lastAudioAt < STALL_MS) return;
      this.onRestart?.("microphone audio stopped; restarting it");
      this.restarting = true;
      void this.launch().finally(() => (this.restarting = false));
    }, 1000);
  }

  stop(): void {
    this.stopping = true;
    clearInterval(this.watchdog);
    this.proc?.stdin?.end("q");
  }

  // Starts a fresh helper; true once its first audio arrives, false if none comes in time.
  private launch(): Promise<boolean> {
    this.proc?.kill();
    this.leftover = undefined;
    const proc = spawn(MIC_CAPTURE, this.echoCancel ? ["--echo-cancel"] : [], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc = proc;
    this.lastAudioAt = Date.now(); // grace period while it starts
    proc.stdin!.on("error", () => {});
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (this.proc !== proc) return;
      this.lastAudioAt = Date.now();
      this.receive(chunk);
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), FIRST_AUDIO_TIMEOUT_MS);
      proc.stdout!.once("data", () => {
        clearTimeout(timer);
        resolve(true);
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private receive(chunk: Buffer): void {
    let bytes = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk;
    this.leftover = bytes.length % 2 ? bytes.subarray(bytes.length - 1) : undefined;
    if (this.leftover) bytes = bytes.subarray(0, bytes.length - 1);
    const samples = new Int16Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
    this.onSamples(samples);
  }
}
