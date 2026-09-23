// Turns Claude's streamed markdown into speakable sentences.
// Code fences are dropped entirely: code goes on screen, never out loud.

const FENCE = "```";
// End of a sentence: terminal punctuation (plus closing quotes/brackets) followed by
// whitespace, or a line break. The whitespace must already have arrived, so we never
// cut "3.5" or a sentence whose next character is still streaming.
const BOUNDARY = /[.!?]+["')\]]*(?=\s)|\n/;

export class SentenceSplitter {
  private pending = "";
  private inFence = false;

  push(delta: string): string[] {
    this.pending += delta;
    const out: string[] = [];

    while (this.pending) {
      if (this.inFence) {
        const close = this.pending.indexOf(FENCE);
        if (close === -1) break;
        this.pending = this.pending.slice(close + FENCE.length);
        this.inFence = false;
        continue;
      }

      const fence = this.pending.indexOf(FENCE);
      const match = BOUNDARY.exec(this.pending);
      const end = match ? match.index + match[0].length : -1;

      if (fence !== -1 && (end === -1 || fence < end)) {
        emit(out, this.pending.slice(0, fence));
        this.pending = this.pending.slice(fence + FENCE.length);
        this.inFence = true;
      } else if (end !== -1) {
        emit(out, this.pending.slice(0, end));
        this.pending = this.pending.slice(end);
      } else {
        break;
      }
    }
    return out;
  }

  // End of turn: whatever is left is the last sentence.
  flush(): string[] {
    const out: string[] = [];
    if (!this.inFence) emit(out, this.pending);
    this.pending = "";
    this.inFence = false;
    return out;
  }
}

function emit(out: string[], raw: string): void {
  const text = speakable(raw);
  if (text) out.push(text);
}

// Strip markdown so `say` doesn't read symbols aloud.
export function speakable(raw: string): string {
  const text = raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}
