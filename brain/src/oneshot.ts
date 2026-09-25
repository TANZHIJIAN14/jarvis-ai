import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

// A single small Claude call (titles, summaries) through the user's own `claude` CLI.
// No tools, no saved session (it would clutter `claude --resume`), run outside any project.
export type Ask = (instruction: string, input: string) => Promise<string>;

export function claudeOneShot(model = "haiku"): Ask {
  return (instruction, input) =>
    new Promise((resolve, reject) => {
      const proc = spawn(
        "claude",
        ["-p", instruction, "--model", model, "--output-format", "json", "--no-session-persistence", "--tools", ""],
        { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
      );
      let out = "";
      proc.stdout!.on("data", (d) => (out += d));
      proc.on("error", reject);
      proc.on("exit", () => {
        try {
          const { result, is_error } = JSON.parse(out) as { result: string; is_error: boolean };
          if (is_error) reject(new Error(result));
          else resolve(result.trim());
        } catch {
          reject(new Error(`unexpected output from claude: ${out.slice(0, 200)}`));
        }
      });
      proc.stdin!.end(input);
    });
}
