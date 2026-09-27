import { basename } from "node:path";
import type { ApprovalRequest } from "./approval-server.ts";

// Turning Claude's permission requests into a spoken question, and the user's reply into a decision.

// "May I run the tests in jarvis-ai?" (spoken) plus the exact command or file (shown on the orb).
export function describeRequest(req: ApprovalRequest): { question: string; detail: string } {
  const input = req.input;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (req.toolName) {
    case "Bash": {
      const what = str("description");
      return {
        question: what ? `May I ${lowerFirst(what.replace(/\.$/, ""))}?` : "May I run a command?",
        detail: str("command"),
      };
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { question: `May I edit ${basename(str("file_path") || str("notebook_path")) || "a file"}?`, detail: str("file_path") || str("notebook_path") };
    case "Write":
      return { question: `May I write ${basename(str("file_path")) || "a file"}?`, detail: str("file_path") };
    case "WebFetch": {
      let host = "";
      try {
        host = new URL(str("url")).hostname;
      } catch {}
      return { question: host ? `May I open ${host}?` : "May I open a web page?", detail: str("url") };
    }
    case "WebSearch":
      return { question: `May I search the web for ${str("query")}?`, detail: str("query") };
    default:
      return { question: `May I use ${req.toolName.replace(/^mcp__\w+__/, "")}?`, detail: JSON.stringify(input).slice(0, 200) };
  }
}

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|go for it|do it|allow( it)?|approved?|please( do)?|fine|alright|all right|of course|affirmative|carry on|proceed)\b/i;
const NO = /^(no|nope|nah|don't|do not|stop|cancel|deny|never ?mind|not now|wait|hold on|skip( it)?)\b/i;

export function parseAnswer(text: string): "yes" | "no" | undefined {
  const t = text.trim().replace(/^(?:hey |ok |okay )?jarvis\W*/i, "");
  if (NO.test(t)) return "no"; // checked first: "no, don't" beats a later "okay"
  if (YES.test(t)) return "yes";
  return undefined;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

// Commands that can't be undone need a click on Allow, not a spoken yes: a misheard
// "yes" must never push, force-reset or delete recursively.
const DESTRUCTIVE = [
  /\brm\s+(?:-\S*[rR]|--recursive)/, // recursive delete
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bsudo\b/,
  /\bnpm\s+publish\b/,
  /\bmkfs\b|\bdd\s+if=/,
  /\bdrop\s+(?:table|database)\b/i,
];

export function isDestructive(req: ApprovalRequest): boolean {
  if (req.toolName !== "Bash") return false;
  const command = typeof req.input.command === "string" ? req.input.command : "";
  return DESTRUCTIVE.some((re) => re.test(command));
}
