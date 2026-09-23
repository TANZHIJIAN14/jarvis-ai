import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SAMPLE_RATE = 16_000; // what whisper.cpp expects
const FRAME = SAMPLE_RATE * 0.03; // 30 ms
const SPEECH_DBFS = -45; // frames louder than this count as speech
const TAIL_MS = 300; // people press Enter while still finishing the last word

export type Recording = { durationMs: number; speechMs: number; peakDbfs: number };

// Built from native/mic-capture.swift (npm run build:native).
export const MIC_CAPTURE = fileURLToPath(new URL("../../native/bin/mic-capture", import.meta.url));

// Records the system's default input as raw 16 kHz mono PCM via the Swift
// mic-capture helper (AVAudioEngine), then writes a WAV.
// Raw PCM on stdout tells us the moment the mic is really live, so we don't
// say "listening" while the device is still opening and lose the first words.
export class Recorder {
  private proc: ChildProcess | undefined;
  private chunks: Buffer[] = [];
  private exited: Promise<number | null> | undefined;

  // Resolves once the first audio arrives.
  start(): Promise<void> {
    if (!existsSync(MIC_CAPTURE)) throw new Error("mic-capture is not built; run npm run build:native");
    this.chunks = [];
    const proc = spawn(MIC_CAPTURE, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.on("exit", resolve));
    proc.stdout!.on("data", (chunk: Buffer) => this.chunks.push(chunk));
    return new Promise((resolve, reject) => {
      proc.stdout!.once("data", () => resolve());
      proc.once("exit", (code) =>
        reject(new Error(`mic-capture exited with code ${code}; check microphone permission`)));
    });
  }

  async stop(wavFile: string): Promise<Recording> {
    const proc = this.proc;
    if (!proc) throw new Error("Not recording");
    await new Promise((r) => setTimeout(r, TAIL_MS));
    proc.stdin!.end("q");
    await this.exited;
    this.proc = undefined;
    const pcm = Buffer.concat(this.chunks);
    writeFileSync(wavFile, toWav(pcm));
    return measure(pcm);
  }
}

export function measure(pcm: Buffer): Recording {
  const count = Math.floor(pcm.length / 2);
  let speechFrames = 0;
  let peak = 0;
  for (let start = 0; start + FRAME <= count; start += FRAME) {
    let sum = 0;
    for (let i = start; i < start + FRAME; i++) {
      const sample = pcm.readInt16LE(i * 2);
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    if (dbfs(Math.sqrt(sum / FRAME)) > SPEECH_DBFS) speechFrames++;
  }
  return {
    durationMs: Math.round((count / SAMPLE_RATE) * 1000),
    speechMs: speechFrames * 30,
    peakDbfs: Math.round(dbfs(peak)),
  };
}

function dbfs(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1) / 32768);
}

export function toWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
