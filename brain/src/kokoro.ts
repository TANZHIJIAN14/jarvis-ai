import { env } from "@huggingface/transformers";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KokoroTTS } from "kokoro-js";
import { toWav } from "./recorder.ts";

// Kokoro-82M neural voice, run locally with ONNX Runtime. The full-precision model is
// faster than the quantized ones on Apple Silicon: ~0.8 s for a first sentence, ~4x real time,
// so later sentences are ready before the previous one finishes playing.

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export class KokoroVoice {
  private tts: KokoroTTS;
  private voice: string;
  private speed: number;
  private dir = join(tmpdir(), "jarvis-tts");
  private count = 0;

  private constructor(tts: KokoroTTS, voice: string, speed: number) {
    this.tts = tts;
    this.voice = voice;
    this.speed = speed;
    mkdirSync(this.dir, { recursive: true });
  }

  // First use downloads the model (~310 MB) into cacheDir.
  static async load(opts: { voice: string; speed: number; cacheDir: string }): Promise<KokoroVoice> {
    env.cacheDir = opts.cacheDir;
    const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "cpu" });
    if (!(opts.voice in tts.voices)) {
      throw new Error(`Unknown Kokoro voice "${opts.voice}". Try one of: ${Object.keys(tts.voices).join(", ")}`);
    }
    const voice = new KokoroVoice(tts, opts.voice, opts.speed);
    // The first generation is ~3x slower (graph warm-up); pay it now, not on the first reply.
    unlinkSync(await voice.synthesize("Ready."));
    return voice;
  }

  // Synthesizes one sentence to a WAV file and returns its path.
  async synthesize(text: string): Promise<string> {
    const audio = await this.tts.generate(text, { voice: this.voice as never, speed: this.speed });
    const pcm = Buffer.alloc(audio.audio.length * 2);
    audio.audio.forEach((sample, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2));
    const file = join(this.dir, `${process.pid}-${this.count++}.wav`);
    writeFileSync(file, toWav(pcm, audio.sampling_rate));
    return file;
  }
}
