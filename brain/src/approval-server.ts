import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Loopback HTTP endpoint that approval-mcp.ts calls when Claude Code needs permission.
// The request waits until the user answers (by voice or on the orb).

export type ApprovalRequest = { sessionId: number; toolName: string; input: Record<string, unknown> };
export type ApprovalDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export class ApprovalServer {
  readonly token = randomBytes(16).toString("hex");
  private server: Server | undefined;
  private decide: (request: ApprovalRequest) => Promise<ApprovalDecision>;

  constructor(decide: (request: ApprovalRequest) => Promise<ApprovalDecision>) {
    this.decide = decide;
  }

  get url(): string {
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/approve`;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/approve" || req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        let decision: ApprovalDecision;
        try {
          decision = await this.decide(JSON.parse(body) as ApprovalRequest);
        } catch (err) {
          decision = { behavior: "deny", message: `Jarvis couldn't ask the user: ${(err as Error).message}` };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
      });
    });
    // Claude waits on the user's answer; don't let Node time the request out.
    this.server.requestTimeout = 0;
    return new Promise((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  // --mcp-config for one Claude process, tagged with the Jarvis session it belongs to.
  mcpConfig(sessionId: number): string {
    const script = new URL("./approval-mcp.ts", import.meta.url).pathname;
    return JSON.stringify({
      mcpServers: {
        jarvis: {
          type: "stdio",
          command: process.execPath,
          args: ["--experimental-strip-types", "--no-warnings", script],
          env: { JARVIS_APPROVAL_URL: this.url, JARVIS_APPROVAL_TOKEN: this.token, JARVIS_SESSION_ID: String(sessionId) },
        },
      },
    });
  }

  close(): void {
    this.server?.close();
  }
}
