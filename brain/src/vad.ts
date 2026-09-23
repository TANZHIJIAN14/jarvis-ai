import ort from "onnxruntime-node";

// Silero VAD v5: probability that a 32 ms frame contains speech.
// Mirrors silero-vad's OnnxWrapper: each call sees the previous frame's last
// 64 samples as context and carries the model's recurrent state forward.

export const VAD_FRAME = 512; // 32 ms at 16 kHz
const CONTEXT = 64;

export class Vad {
  private session: ort.InferenceSession;
  private state = new Float32Array(2 * 1 * 128);
  private context = new Float32Array(CONTEXT);
  private sr = new ort.Tensor("int64", BigInt64Array.from([16_000n]), []);

  private constructor(session: ort.InferenceSession) {
    this.session = session;
  }

  static async load(modelPath: string): Promise<Vad> {
    return new Vad(await ort.InferenceSession.create(modelPath));
  }

  async process(frame: Int16Array): Promise<number> {
    if (frame.length !== VAD_FRAME) throw new Error(`Vad.process needs ${VAD_FRAME} samples`);
    const input = new Float32Array(CONTEXT + VAD_FRAME);
    input.set(this.context);
    for (let i = 0; i < VAD_FRAME; i++) input[CONTEXT + i] = frame[i] / 32768;
    this.context = input.slice(-CONTEXT);

    const out = await this.session.run({
      input: new ort.Tensor("float32", input, [1, input.length]),
      state: new ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: this.sr,
    });
    this.state = Float32Array.from(out.stateN.data as Float32Array);
    return (out.output.data as Float32Array)[0];
  }

  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
  }
}
