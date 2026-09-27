import { basename } from "node:path";

// The "what Jarvis is doing" line under a reply, and a background task's activity:
// one short phrase per tool call ("Reading listener.test.ts", "Run the test suite").
export function describeActivity(tool: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const file = () => basename(str("file_path") || str("notebook_path") || str("path")) || "a file";
  switch (tool) {
    case "Read":
      return `Reading ${file()}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Editing ${file()}`;
    case "Write":
      return `Writing ${file()}`;
    case "Grep":
      return str("pattern") ? `Searching for “${str("pattern")}”` : "Searching the code";
    case "Glob":
    case "LS":
      return "Looking for files";
    case "Bash":
      return str("description").replace(/\.$/, "") || `Running ${str("command").split("\n")[0].slice(0, 60)}`;
    case "WebSearch":
      return `Searching the web for ${str("query")}`;
    case "WebFetch": {
      try {
        return `Reading ${new URL(str("url")).hostname}`;
      } catch {
        return "Reading a web page";
      }
    }
    case "TodoWrite":
      return "Planning the steps";
    case "Task":
    case "Agent":
      return str("description") || "Handing part of this to a helper";
    default:
      return `Using ${tool.replace(/^mcp__[^_]+__/, "")}`;
  }
}
