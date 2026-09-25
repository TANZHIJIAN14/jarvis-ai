import ort from "onnxruntime-node";
import { join } from "node:path";
import { SMALL_MODEL_OPTIONS } from "./vad.ts";

// "Hey Jarvis" detection with openWakeWord's pre-trained models, ported from its
// streaming pipeline (openwakeword/utils.py AudioFeatures._streaming_features):
//   every 80 ms of audio -> mel-spectrogram frames -> 96-d speech embedding
//   -> the last 16 embeddings -> hey_jarvis score in [0, 1].

export const CHUNK = 1280; // 80 ms at 16 kHz: the model's step
const CONTEXT = 160 * 3; // extra samples the mel model needs to emit frames for a whole chunk
const MEL_BINS = 32;
const MEL_WINDOW = 76; // mel frames per embedding
const EMBEDDINGS = 16; // embeddings per wake-word prediction
const MAX_EMBEDDINGS = 120;

export class WakeWord {
  private raw = new Float32Array(CHUNK + CONTEXT);
  // Seeded with ones, as openWakeWord does, so the first embedding has a full window.
  private mel: Float32Array[] = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
  private embeddings: Float32Array[] = [];
  private melModel: ort.InferenceSession;
  private embeddingModel: ort.InferenceSession;
  private wakeModel: ort.InferenceSession;

  private constructor(mel: ort.InferenceSession, embedding: ort.InferenceSession, wake: ort.InferenceSession) {
    this.melModel = mel;
    this.embeddingModel = embedding;
    this.wakeModel = wake;
  }

  static async load(modelsDir: string): Promise<WakeWord> {
    const open = (name: string) => ort.InferenceSession.create(join(modelsDir, name), SMALL_MODEL_OPTIONS);
    return new WakeWord(
      await open("melspectrogram.onnx"),
      await open("embedding_model.onnx"),
      await open("hey_jarvis.onnx"),
    );
  }

  // Feed exactly CHUNK samples. Returns the wake-word score, or undefined while
  // there isn't enough history yet (about 1.3 s after start or reset).
  async process(chunk: Int16Array): Promise<number | undefined> {
    if (chunk.length !== CHUNK) throw new Error(`WakeWord.process needs ${CHUNK} samples`);
    this.raw.copyWithin(0, CHUNK);
    for (let i = 0; i < CHUNK; i++) this.raw[CONTEXT + i] = chunk[i]; // raw int16 values, not normalised

    const melOut = await this.melModel.run({ input: new ort.Tensor("float32", this.raw, [1, this.raw.length]) });
    const melData = first(melOut).data as Float32Array;
    for (let f = 0; f + MEL_BINS <= melData.length; f += MEL_BINS) {
      this.mel.push(melData.slice(f, f + MEL_BINS).map((x) => x / 10 + 2));
    }
    this.mel.splice(0, this.mel.length - MEL_WINDOW);

    const window = new Float32Array(MEL_WINDOW * MEL_BINS);
    this.mel.forEach((frame, i) => window.set(frame, i * MEL_BINS));
    const embOut = await this.embeddingModel.run({
      input_1: new ort.Tensor("float32", window, [1, MEL_WINDOW, MEL_BINS, 1]),
    });
    this.embeddings.push(Float32Array.from(first(embOut).data as Float32Array));
    this.embeddings.splice(0, this.embeddings.length - MAX_EMBEDDINGS);
    if (this.embeddings.length < EMBEDDINGS) return undefined;

    const features = new Float32Array(EMBEDDINGS * 96);
    this.embeddings.slice(-EMBEDDINGS).forEach((e, i) => features.set(e, i * 96));
    const name = this.wakeModel.inputNames[0];
    const out = await this.wakeModel.run({ [name]: new ort.Tensor("float32", features, [1, EMBEDDINGS, 96]) });
    return (first(out).data as Float32Array)[0];
  }

  // Forget recent audio so the phrase that just fired can't fire again.
  reset(): void {
    this.raw.fill(0);
    this.embeddings = [];
  }
}

function first(out: ort.InferenceSession.OnnxValueMapType): ort.Tensor {
  return Object.values(out)[0] as ort.Tensor;
}
