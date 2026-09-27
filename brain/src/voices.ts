import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KokoroVoice } from "./kokoro.ts";
import { isKokoroVoice } from "./settings.ts";
import type { Synthesize } from "./speaker.ts";

// Jarvis's voice, following Settings as it changes: Kokoro voices on the worker thread, or an
// Apple system voice rendered to a file with `say`. Without Kokoro (still downloading, or it
// failed to load), every voice falls back to the Apple one.

const dir = join(tmpdir(), "jarvis-tts");
const APPLE_WPM = 185; // `say`'s default rate, scaled by the speaking speed
let count = 0;

export function voiceSynth(current: () => { voice: string; voiceSpeed: number }, kokoro: () => KokoroVoice | undefined): {
  synthesize: Synthesize;
  sample: (voice: string) => Synthesize;
} {
  const using = (voice: () => string): Synthesize => (text) => {
    const { voiceSpeed } = current();
    const engine = kokoro();
    if (isKokoroVoice(voice()) && engine) return engine.synthesize(text, { voice: voice(), speed: voiceSpeed });
    return appleSay(text, isKokoroVoice(voice()) ? "Samantha" : voice(), voiceSpeed);
  };
  return { synthesize: using(() => current().voice), sample: (voice) => using(() => voice) };
}

function appleSay(text: string, voice: string, speed: number): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}-say-${count++}.wav`);
  const name = voice[0].toUpperCase() + voice.slice(1);
  const run = (args: string[]) => new Promise<number>((resolve) => {
    spawn("say", [...args, "-r", String(Math.round(APPLE_WPM * speed)), "-o", file, "--data-format=LEI16@22050", text], { stdio: "ignore" })
      .on("exit", (code) => resolve(code ?? 1))
      .on("error", () => resolve(1));
  });
  return run(["-v", name]).then(async (code) => {
    if (code !== 0 && (await run([])) !== 0) throw new Error("The Apple voice couldn't speak");
    return file;
  });
}
