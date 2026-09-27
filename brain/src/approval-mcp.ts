// A tiny stdio MCP server that Claude Code calls when it needs permission for something
// (`--permission-prompt-tool mcp__jarvis__approve`). It forwards the request to the brain,
// which asks the user out loud and on the orb, and returns the decision to Claude Code.
//
// Run by Claude Code via --mcp-config; configured with environment variables:
//   JARVIS_APPROVAL_URL    the brain's approval endpoint (loopback)
//   JARVIS_APPROVAL_TOKEN  per-run secret
//   JARVIS_SESSION_ID      which Jarvis session this Claude process belongs to

import { createInterface } from "node:readline";

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any };

const { JARVIS_APPROVAL_URL: url, JARVIS_APPROVAL_TOKEN: token, JARVIS_SESSION_ID: sessionId } = process.env;

function send(message: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function decide(toolName: string, input: unknown): Promise<object> {
  try {
    const res = await fetch(url!, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: Number(sessionId), toolName, input }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as object;
  } catch (err) {
    return { behavior: "deny", message: `Could not reach Jarvis to ask the user (${(err as Error).message}).` };
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: Message;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "jarvis", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({
        id: msg.id,
        result: {
          tools: [{
            name: "approve",
            description: "Asks the user (by voice) whether Claude may use a tool.",
            inputSchema: {
              type: "object",
              properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
              required: ["tool_name", "input"],
            },
          }],
        },
      });
      break;
    case "tools/call": {
      const { tool_name, input } = msg.params?.arguments ?? {};
      const decision = await decide(tool_name, input);
      send({ id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
      break;
    }
    case "ping":
      send({ id: msg.id, result: {} });
      break;
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
  }
});
