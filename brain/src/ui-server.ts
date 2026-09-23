import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { UiCommand, UiEvent } from "./jarvis.ts";

// Local WebSocket the Jarvis UI connects to. Loopback only, and every client must
// present the per-run token the brain passes to the UI on its command line.
export class UiServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<WebSocket>();
  private port: number;
  private token: string;
  private onCommand: (command: UiCommand) => void;
  private snapshot: () => UiEvent[];

  constructor(opts: {
    port: number;
    token: string;
    onCommand: (command: UiCommand) => void;
    snapshot: () => UiEvent[]; // sent to a client when it connects
  }) {
    this.port = opts.port;
    this.token = opts.token;
    this.onCommand = opts.onCommand;
    this.snapshot = opts.snapshot;
  }

  start(): Promise<void> {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
      verifyClient: ({ req }: { req: IncomingMessage }) => new URL(req.url ?? "/", "http://localhost").searchParams.get("token") === this.token,
    });
    this.wss = wss;
    wss.on("connection", (ws) => {
      this.clients.add(ws);
      for (const event of this.snapshot()) ws.send(JSON.stringify(event));
      ws.on("message", (data) => {
        try {
          this.onCommand(JSON.parse(String(data)) as UiCommand);
        } catch {
          // ignore malformed messages
        }
      });
      ws.on("close", () => this.clients.delete(ws));
    });
    return new Promise((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
  }

  broadcast(event: UiEvent): void {
    const message = JSON.stringify(event);
    for (const ws of this.clients) ws.send(message);
  }

  close(): void {
    this.wss?.close();
  }
}
