import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { MIC_CAPTURE } from "./recorder.ts";

// Continuous 16 kHz mono mic audio from the mic-capture helper, as Int16 sample chunks.
export class MicStream {
  private proc: ChildProcess | undefined;
  private leftover: Buffer | undefined; // a pipe read can end mid-sample
  private onSamples: (samples: Int16Array) => void;
  private stopping = false;

  constructor(onSamples: (samples: Int16Array) => void) {
    this.onSamples = onSamples;
  }

  // Resolves once audio is flowing.
  start(): Promise<void> {
    if (!existsSync(MIC_CAPTURE)) throw new Error("mic-capture is not built; run npm run build:native");
    const proc = spawn(MIC_CAPTURE, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc = proc;
    proc.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    return new Promise((resolve, reject) => {
      proc.stdout!.once("data", () => resolve());
      proc.once("exit", (code) => {
        if (!this.stopping) reject(new Error(`mic-capture exited with code ${code}; check microphone permission`));
      });
    });
  }

  stop(): void {
    this.stopping = true;
    this.proc?.stdin?.end("q");
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
