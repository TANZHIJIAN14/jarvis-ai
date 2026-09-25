import { env } from "@huggingface/transformers";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { KokoroTTS } from "kokoro-js";
import { toWav } from "./recorder.ts";

// Runs Kokoro off the main thread. Synthesis is partly synchronous JavaScript (phonemizing,
// tensor prep) and blocked the main event loop for seconds per reply, starving the mic stream:
// the wake word and talk-over detection heard nothing while Jarvis spoke.
//
// in:  { id, text }      out: { ready } | { id, file } | { id, error } | { loadError }

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const { voice, speed, cacheDir } = workerData as { voice: string; speed: number; cacheDir: string };
const dir = join(tmpdir(), "jarvis-tts");
mkdirSync(dir, { recursive: true });
let count = 0;

async function synthesize(tts: KokoroTTS, text: string): Promise<string> {
  const audio = await tts.generate(text, { voice: voice as never, speed });
  const pcm = Buffer.alloc(audio.audio.length * 2);
  audio.audio.forEach((sample, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2));
  const file = join(dir, `${process.pid}-${count++}.wav`);
  writeFileSync(file, toWav(pcm, audio.sampling_rate));
  return file;
}

try {
  env.cacheDir = cacheDir;
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "cpu" });
  if (!(voice in tts.voices)) {
    throw new Error(`Unknown Kokoro voice "${voice}". Try one of: ${Object.keys(tts.voices).join(", ")}`);
  }
  // The first generation is ~3x slower (graph warm-up); pay it now, not on the first reply.
  unlinkSync(await synthesize(tts, "Ready."));

  // One sentence at a time, in order.
  let queue = Promise.resolve();
  parentPort!.on("message", ({ id, text }: { id: number; text: string }) => {
    queue = queue.then(async () => {
      try {
        parentPort!.postMessage({ id, file: await synthesize(tts, text) });
      } catch (err) {
        parentPort!.postMessage({ id, error: (err as Error).message });
      }
    });
  });
  parentPort!.postMessage({ ready: true });
} catch (err) {
  parentPort!.postMessage({ loadError: (err as Error).message });
}
