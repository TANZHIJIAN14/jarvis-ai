import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// What a background task changed on disk, for its report: files with lines added and removed,
// and a unified diff. Each file is snapshotted the first time Claude reaches for an edit tool
// on it (the tool call arrives before it runs), and compared with the file as it is at report
// time. A denied or failed edit leaves the file unchanged, so it doesn't show up.

export type FileChange = { path: string; added: number; removed: number };
export type Changes = { files: FileChange[]; diff: string };

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const MAX_SNAPSHOT = 2_000_000; // bytes; bigger files are left out of the diff
const MAX_DIFF = 200_000; // characters

export class ChangeTracker {
  private cwd: string;
  private before = new Map<string, string | null | undefined>(); // absolute path -> content; null = didn't exist, undefined = too big

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  onTool(name: string, input: Record<string, unknown>): void {
    if (!EDIT_TOOLS.has(name)) return;
    const file = input.file_path ?? input.notebook_path;
    if (typeof file !== "string" || !file) return;
    const path = isAbsolute(file) ? file : resolve(this.cwd, file);
    if (this.before.has(path)) return;
    this.before.set(path, read(path));
  }

  get touched(): number {
    return this.before.size;
  }

  // Compares every touched file with how it is now.
  collect(): Changes {
    const files: FileChange[] = [];
    let diff = "";
    const dir = mkdtempSync(join(tmpdir(), "jarvis-diff-"));
    try {
      for (const [path, old] of this.before) {
        const now = read(path);
        if (old === now || old === undefined || now === undefined) continue;
        const shown = displayPath(path, this.cwd);
        const a = join(dir, "a");
        const b = join(dir, "b");
        writeFileSync(a, old ?? "");
        writeFileSync(b, now ?? "");
        const out = spawnSync("diff", ["-u", "--label", old === null ? "/dev/null" : `a/${shown}`, "--label", now === null ? "/dev/null" : `b/${shown}`, a, b], { encoding: "utf8" }).stdout ?? "";
        let added = 0;
        let removed = 0;
        for (const line of out.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) added++;
          else if (line.startsWith("-") && !line.startsWith("---")) removed++;
        }
        files.push({ path: shown, added, removed });
        diff += out.endsWith("\n") ? out : `${out}\n`;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (diff cut short)\n`;
    return { files, diff };
  }
}

// Content, null when the file doesn't exist, undefined when it's too big or unreadable.
function read(path: string): string | null | undefined {
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).size > MAX_SNAPSHOT) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

// "2 files changed" for speech.
export function spokenChanges(files: FileChange[]): string {
  if (files.length === 0) return "No files changed.";
  return files.length === 1 ? "1 file changed." : `${files.length} files changed.`;
}
