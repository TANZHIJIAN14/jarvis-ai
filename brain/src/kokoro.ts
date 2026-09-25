import { Worker } from "node:worker_threads";

// Kokoro-82M neural voice, run locally with ONNX Runtime on a worker thread (kokoro-worker.ts),
// so synthesis never blocks the main loop that handles the mic. The full-precision model is
// faster than the quantized ones on Apple Silicon: ~0.8 s for a first sentence, ~4x real time,
// so later sentences are ready before the previous one finishes playing.

type Reply = { id: number; file?: string; error?: string };

export class KokoroVoice {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (file: string) => void; reject: (err: Error) => void }>();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.on("message", (reply: Reply) => {
      const call = this.pending.get(reply.id);
      if (!call) return;
      this.pending.delete(reply.id);
      if (reply.file) call.resolve(reply.file);
      else call.reject(new Error(reply.error ?? "synthesis failed"));
    });
    worker.on("error", (err) => this.failAll(err));
    worker.on("exit", () => this.failAll(new Error("Kokoro worker stopped")));
  }

  // First use downloads the model (~310 MB) into cacheDir.
  static load(opts: { voice: string; speed: number; cacheDir: string }): Promise<KokoroVoice> {
    const worker = new Worker(new URL("./kokoro-worker.ts", import.meta.url), { workerData: opts });
    return new Promise((resolve, reject) => {
      const onMessage = (message: { ready?: boolean; loadError?: string }) => {
        if (message.ready) {
          worker.off("message", onMessage);
          resolve(new KokoroVoice(worker));
        } else if (message.loadError) {
          void worker.terminate();
          reject(new Error(message.loadError));
        }
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
    });
  }

  // Synthesizes one sentence to a WAV file and returns its path.
  synthesize(text: string): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, text });
    });
  }

  close(): void {
    void this.worker.terminate();
  }

  private failAll(err: Error): void {
    for (const call of this.pending.values()) call.reject(err);
    this.pending.clear();
  }
}
