import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// The small models Jarvis downloads on first start (the same list as scripts/fetch-models.sh),
// so Jarvis.app sets itself up without a terminal. Required ones stop startup if they can't be
// fetched; the live-words model is optional.

const OWW = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
export const MODEL_FILES = [
  { file: "melspectrogram.onnx", url: `${OWW}/melspectrogram.onnx`, required: true },
  { file: "embedding_model.onnx", url: `${OWW}/embedding_model.onnx`, required: true },
  { file: "hey_jarvis.onnx", url: `${OWW}/hey_jarvis_v0.1.onnx`, required: true },
  { file: "silero_vad.onnx", url: "https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx", required: true },
  { file: "ggml-base.en.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin", required: false },
];

export async function ensureModels(dir: string, log: (line: string) => void): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const model of MODEL_FILES) {
    const path = join(dir, model.file);
    if (existsSync(path) && statSync(path).size > 0) continue;
    log(`Downloading ${model.file}…`);
    try {
      await download(model.url, path);
    } catch (err) {
      if (model.required) throw new Error(`Couldn't download ${model.file}: ${(err as Error).message}`);
      log(`Skipped ${model.file} (${(err as Error).message}); live words stay off.`);
    }
  }
}

async function download(url: string, path: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const partial = `${path}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial));
    renameSync(partial, path);
  } catch (err) {
    if (existsSync(partial)) unlinkSync(partial);
    throw err;
  }
}
