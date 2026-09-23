import { CHUNK } from "./wake-word.ts";
import { VAD_FRAME } from "./vad.ts";

// Turns a continuous mic stream into turns:
//  - "wake" mode: every 80 ms goes to the wake-word model; a score over the threshold fires onWake.
//  - "capture" mode: 32 ms frames go to the VAD; the utterance ends after a stretch of silence.
// The orchestrator switches modes; models are injected so endpointing can be tested with fakes.

const MS_PER_SAMPLE = 1000 / 16_000;
const VAD_FRAME_MS = VAD_FRAME * MS_PER_SAMPLE;

export type WakeModel = { process(chunk: Int16Array): Promise<number | undefined>; reset(): void };
export type VadModel = { process(frame: Int16Array): Promise<number>; reset(): void };

export type ListenerHandlers = {
  onWake?: (score: number) => void;
  onSpeechStart?: () => void;
  onUtterance?: (pcm: Int16Array) => void;
  onNoSpeech?: () => void;
  onLevel?: (level: number) => void; // 0..1, for the orb
};

export type CaptureOptions = {
  preRollMs: number; // audio from before capture started, e.g. the "Hey Jarvis" itself
  noSpeechTimeoutMs: number; // give up if nobody starts talking
};

export type ListenerOptions = {
  wakeThreshold: number;
  wakeCooldownMs: number;
  speechOn: number; // VAD probability that counts as speech
  speechOff: number; // below this counts as silence (hysteresis)
  minSpeechMs: number; // speech needed before an utterance "starts" (ignores clicks)
  endSilenceMs: number; // silence after speech that ends the utterance
  maxUtteranceMs: number;
  historyMs: number; // how much audio is kept for pre-roll
};

export const DEFAULT_LISTENER_OPTIONS: ListenerOptions = {
  wakeThreshold: 0.5,
  wakeCooldownMs: 1500,
  speechOn: 0.5,
  speechOff: 0.35,
  minSpeechMs: 96,
  endSilenceMs: 700,
  maxUtteranceMs: 30_000,
  historyMs: 2000,
};

type Capture = CaptureOptions & {
  audio: Int16Array[];
  elapsedMs: number;
  speechMs: number;
  silenceMs: number;
  started: boolean;
};

export class Listener {
  private wake: WakeModel;
  private vad: VadModel;
  private handlers: ListenerHandlers;
  private opts: ListenerOptions;
  private history: Int16Array[] = [];
  private historySamples = 0;
  private wakePending: Int16Array = new Int16Array(0);
  private vadPending: Int16Array = new Int16Array(0);
  private capture: Capture | undefined;
  private cooldownMs = 0;
  private queue = Promise.resolve();

  constructor(wake: WakeModel, vad: VadModel, handlers: ListenerHandlers, opts: Partial<ListenerOptions> = {}) {
    this.wake = wake;
    this.vad = vad;
    this.handlers = handlers;
    this.opts = { ...DEFAULT_LISTENER_OPTIONS, ...opts };
  }

  get capturing(): boolean {
    return this.capture !== undefined;
  }

  // Model calls are async; chunks are processed strictly in order.
  feed(samples: Int16Array): Promise<void> {
    this.queue = this.queue.then(() => this.process(samples));
    return this.queue;
  }

  startCapture(opts: CaptureOptions): void {
    const preRoll = takeLast(this.history, Math.round(opts.preRollMs / MS_PER_SAMPLE));
    this.vad.reset();
    this.vadPending = new Int16Array(0);
    this.capture = { ...opts, audio: [preRoll], elapsedMs: 0, speechMs: 0, silenceMs: 0, started: false };
  }

  stopCapture(): void {
    this.capture = undefined;
  }

  private async process(samples: Int16Array): Promise<void> {
    this.remember(samples);
    this.handlers.onLevel?.(level(samples));
    if (this.capture) {
      this.capture.audio.push(samples);
      await this.processCapture(samples);
    } else {
      await this.processWake(samples);
    }
  }

  private async processWake(samples: Int16Array): Promise<void> {
    this.wakePending = concat(this.wakePending, samples);
    let offset = 0;
    for (; offset + CHUNK <= this.wakePending.length; offset += CHUNK) {
      const score = await this.wake.process(this.wakePending.subarray(offset, offset + CHUNK));
      this.cooldownMs = Math.max(0, this.cooldownMs - CHUNK * MS_PER_SAMPLE);
      if (score !== undefined && score >= this.opts.wakeThreshold && this.cooldownMs === 0) {
        this.cooldownMs = this.opts.wakeCooldownMs;
        this.wake.reset();
        this.wakePending = this.wakePending.slice(offset + CHUNK);
        this.handlers.onWake?.(score);
        return; // the orchestrator decides what the rest of the audio is for
      }
    }
    this.wakePending = this.wakePending.slice(offset);
  }

  private async processCapture(samples: Int16Array): Promise<void> {
    this.vadPending = concat(this.vadPending, samples);
    let offset = 0;
    for (; offset + VAD_FRAME <= this.vadPending.length; offset += VAD_FRAME) {
      const c = this.capture;
      if (!c) break;
      const p = await this.vad.process(this.vadPending.subarray(offset, offset + VAD_FRAME));
      c.elapsedMs += VAD_FRAME_MS;
      if (p >= this.opts.speechOn) {
        c.speechMs += VAD_FRAME_MS;
        c.silenceMs = 0;
        if (!c.started && c.speechMs >= this.opts.minSpeechMs) {
          c.started = true;
          this.handlers.onSpeechStart?.();
        }
      } else if (p < this.opts.speechOff) {
        c.silenceMs += VAD_FRAME_MS;
      }

      if (c.started && (c.silenceMs >= this.opts.endSilenceMs || c.elapsedMs >= this.opts.maxUtteranceMs)) {
        this.capture = undefined;
        this.wake.reset();
        this.handlers.onUtterance?.(concatAll(c.audio));
      } else if (!c.started && c.elapsedMs >= c.noSpeechTimeoutMs) {
        this.capture = undefined;
        this.wake.reset();
        this.handlers.onNoSpeech?.();
      }
    }
    this.vadPending = this.vadPending.slice(offset);
  }

  private remember(samples: Int16Array): void {
    this.history.push(samples);
    this.historySamples += samples.length;
    const max = this.opts.historyMs / MS_PER_SAMPLE;
    while (this.history.length > 1 && this.historySamples - this.history[0].length >= max) {
      this.historySamples -= this.history.shift()!.length;
    }
  }
}

// Rough loudness for display: RMS mapped from -60..0 dBFS onto 0..1.
export function level(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const db = 20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1) / 32768);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  if (a.length === 0) return b;
  const out = new Int16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function takeLast(parts: Int16Array[], count: number): Int16Array {
  const all = concatAll(parts);
  return all.slice(Math.max(0, all.length - count));
}
