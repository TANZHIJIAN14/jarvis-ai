import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openAsBlob } from "node:fs";
import { toWav } from "./recorder.ts";

// Runs whisper-server once so the 1.5 GB model stays loaded between turns
// (whisper-cli reloads it every call: ~25 s cold vs ~1.4 s warm).
export class Transcriber {
  private proc: ChildProcess | undefined;
  private url: string;
  private model: string;
  private language: string;
  private port: number;
  private vocabulary: string;

  constructor(opts: { model: string; language: string; port: number; vocabulary: string }) {
    this.model = opts.model;
    this.language = opts.language;
    this.port = opts.port;
    this.vocabulary = opts.vocabulary;
    this.url = `http://127.0.0.1:${opts.port}`;
  }

  async start(timeoutMs = 60_000): Promise<void> {
    if (!existsSync(this.model)) throw new Error(`Whisper model not found: ${this.model}`);
    const args = [
      "-m", this.model, "-l", this.language, "--host", "127.0.0.1", "--port", String(this.port),
      // The server decodes greedily by default; beam search is noticeably more accurate.
      "--beam-size", "5", "--best-of", "5",
      // Stops "[music]"-style tokens, a common source of made-up text on quiet audio.
      "--suppress-nst",
    ];
    // Whisper treats the prompt as preceding text, which nudges it toward these spellings.
    if (this.vocabulary) args.push("--prompt", this.vocabulary);
    this.proc = spawn("whisper-server", args, { stdio: "ignore" });
    const failed = new Promise<never>((_, reject) =>
      this.proc!.on("exit", (code) => reject(new Error(`whisper-server exited with code ${code}`))),
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const up = await Promise.race([fetch(this.url).then(() => true, () => false), failed]);
      if (up) return this.warmUp();
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("whisper-server did not start in time");
  }

  async transcribe(wavFile: string): Promise<string> {
    return this.send(await openAsBlob(wavFile));
  }

  // 16 kHz mono 16-bit PCM, straight from the listener.
  transcribePcm(pcm: Buffer): Promise<string> {
    return this.send(new Blob([new Uint8Array(toWav(pcm))]));
  }

  // The first request after loading is several seconds slower (GPU kernels get compiled),
  // so spend it on half a second of silence at startup instead of on the user's first words.
  private async warmUp(): Promise<void> {
    const silence = new Uint8Array(toWav(Buffer.alloc(16_000)));
    await this.send(new Blob([silence]));
  }

  private async send(audio: Blob): Promise<string> {
    const form = new FormData();
    form.append("file", audio, "audio.wav");
    form.append("response_format", "json");
    const res = await fetch(`${this.url}/inference`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`whisper-server: HTTP ${res.status}`);
    const { text } = (await res.json()) as { text: string };
    return cleanTranscript(text);
  }

  stop(): void {
    this.proc?.kill();
  }
}

// Whisper marks silence and noise with tags like [BLANK_AUDIO] or (wind blowing).
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}
