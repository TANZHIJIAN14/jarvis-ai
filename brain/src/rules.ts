import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ApprovalRequest } from "./approval-server.ts";
import { isDestructive } from "./approvals.ts";

// "Always allow" rules: answers the user gave once, for a folder. A rule is either a command
// prefix ("npm test", "git status") or file edits, and holds only inside its folder.
// Destructive commands always ask, and compound commands (pipes, &&, redirects) aren't matched,
// so "npm test && git push" can't slip through under "npm test".

export type AllowRule = { kind: "command"; prefix: string; cwd: string } | { kind: "edits"; cwd: string };

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Tools whose first argument is a subcommand: "git status" is a rule, not "git".
const WITH_SUBCOMMAND = new Set(["git", "npm", "npx", "pnpm", "yarn", "bun", "cargo", "go", "docker", "brew", "swift",
  "xcrun", "gh", "make", "pip", "pip3", "uv", "node"]);

// The rule "Always allow" would save for this request, if one makes sense.
export function ruleFor(request: ApprovalRequest, cwd: string): AllowRule | undefined {
  if (isDestructive(request)) return undefined;
  if (EDIT_TOOLS.has(request.toolName)) {
    const file = request.input.file_path ?? request.input.notebook_path;
    if (typeof file !== "string" || !inside(file, cwd)) return undefined;
    // In the home folder that would be everything: keep it to the file's own folder.
    return { kind: "edits", cwd: cwd === homedir() ? dirname(resolve(cwd, file)) : cwd };
  }
  if (request.toolName !== "Bash") return undefined;
  const prefix = commandPrefix(String(request.input.command ?? ""));
  return prefix ? { kind: "command", prefix, cwd } : undefined;
}

export function commandPrefix(command: string): string | undefined {
  const text = command.trim();
  if (!text || /[;&|<>`\n]|\$\(/.test(text)) return undefined; // compound or redirected
  const words = text.split(/\s+/);
  if (/^\w+=/.test(words[0])) return undefined; // FOO=bar cmd
  const take = WITH_SUBCOMMAND.has(words[0]) && words[1] && !words[1].startsWith("-") ? 2 : 1;
  return words.slice(0, take).join(" ");
}

export function describeRule(rule: AllowRule): string {
  return rule.kind === "edits" ? "Edit files" : `Run “${rule.prefix}”`;
}

export class AllowRules {
  private path: string | undefined;
  rules: AllowRule[] = [];

  // No path: in memory only (tests).
  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) {
      try {
        this.rules = JSON.parse(readFileSync(path, "utf8")) as AllowRule[];
      } catch {
        this.rules = [];
      }
    }
  }

  allows(request: ApprovalRequest, cwd: string): boolean {
    if (isDestructive(request)) return false;
    const wanted = ruleFor(request, cwd);
    if (!wanted) return false;
    return this.rules.some((rule) => rule.kind === wanted.kind && inside(wanted.cwd, rule.cwd)
      && (rule.kind === "edits" || (wanted.kind === "command" && matchesPrefix(String(request.input.command ?? ""), rule.prefix))));
  }

  add(rule: AllowRule): void {
    if (this.rules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) return;
    this.rules.push(rule);
    this.save();
  }

  remove(index: number): void {
    this.rules.splice(index, 1);
    this.save();
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.rules, null, 2));
  }
}

function matchesPrefix(command: string, prefix: string): boolean {
  const text = command.trim().replace(/\s+/g, " ");
  return text === prefix || text.startsWith(`${prefix} `);
}

function inside(path: string, folder: string): boolean {
  const rel = relative(folder, isAbsolute(path) ? path : resolve(folder, path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}
