import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// One long-lived Claude Code conversation, driven through the user's own `claude`
// CLI (their subscription login) in headless stream-json mode.
// Each ask() writes one user message to stdin; the turn ends at the `result` event.

export type TurnHandlers = {
  onText?: (delta: string) => void;
  onTool?: (name: string, input: Record<string, unknown>) => void;
};

export type TurnResult = {
  text: string;
  isError: boolean;
  interrupted: boolean;
  sessionId: string | undefined;
};

export type SessionOptions = {
  cwd: string;
  model?: string;
  permissionMode?: string;
  appendSystemPromptFile?: string;
  resume?: string;
};

type Turn = { handlers: TurnHandlers; resolve: (r: TurnResult) => void };

export class ClaudeSession {
  sessionId: string | undefined;
  private opts: SessionOptions;
  private proc: ChildProcess | undefined;
  private turn: Turn | undefined;
  private closing = false;
  private interrupting = false;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.sessionId = opts.resume;
  }

  get busy(): boolean {
    return this.turn !== undefined;
  }

  ask(text: string, handlers: TurnHandlers = {}): Promise<TurnResult> {
    if (this.turn) throw new Error("A turn is already running");
    // The process may have exited (interrupt, crash, idle shutdown); --resume picks up the same conversation.
    if (!this.proc) this.spawn();
    return new Promise((resolve) => {
      this.turn = { handlers, resolve };
      const message = { type: "user", message: { role: "user", content: text } };
      this.proc!.stdin!.write(JSON.stringify(message) + "\n");
    });
  }

  // Ends the current turn. SIGINT, not SIGTERM: SIGTERM leaves the turn unfinished.
  // The CLI answers with a `result` and then exits by itself about a second later.
  interrupt(): void {
    if (!this.turn || !this.proc) return;
    this.interrupting = true;
    this.proc.kill("SIGINT");
  }

  close(): void {
    this.closing = true;
    this.proc?.stdin?.end();
    this.proc?.kill("SIGTERM");
  }

  private spawn(): void {
    const { cwd, model, permissionMode, appendSystemPromptFile } = this.opts;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (appendSystemPromptFile) args.push("--append-system-prompt-file", appendSystemPromptFile);
    if (this.sessionId) args.push("--resume", this.sessionId);

    // Own process group, so Ctrl+C in Jarvis's terminal doesn't also hit Claude.
    const proc = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "inherit"], detached: true });
    this.proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (this.proc === proc) this.onLine(line);
    });
    proc.on("exit", () => {
      if (this.proc !== proc) return; // already retired
      this.proc = undefined;
      const expected = this.closing || this.interrupting;
      this.interrupting = false;
      this.finishTurn({ text: "", isError: !expected, interrupted: true });
    });
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not an event
    }
    if (msg.session_id) this.sessionId = msg.session_id;
    const handlers = this.turn?.handlers;

    switch (msg.type) {
      case "stream_event": {
        const event = msg.event;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          handlers?.onText?.(event.delta.text);
        } else if (event.type === "content_block_stop") {
          // Text blocks around tool calls arrive back to back; keep them apart as sentences.
          handlers?.onText?.("\n");
        }
        break;
      }
      case "assistant":
        // Full messages repeat the streamed text, so only tool calls are taken from here.
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") handlers?.onTool?.(block.name, block.input ?? {});
        }
        break;
      case "result":
        if (this.interrupting) {
          // Retire the exiting process now, so the next ask() doesn't write into it.
          this.interrupting = false;
          this.proc = undefined;
          this.finishTurn({ text: msg.result ?? "", isError: false, interrupted: true });
          break;
        }
        this.finishTurn({
          text: msg.result ?? "",
          isError: Boolean(msg.is_error) || msg.subtype !== "success",
          interrupted: false,
        });
        break;
    }
  }

  private finishTurn(result: Omit<TurnResult, "sessionId">): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.resolve({ ...result, sessionId: this.sessionId });
  }
}
