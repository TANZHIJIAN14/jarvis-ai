import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ClaudeSession } from "./claude-session.ts";
import type { HistoryStore, SessionRecord } from "./history.ts";
import type { Ask } from "./oneshot.ts";

// Which Claude Code conversation the next request goes to, per the design doc:
//  - a wake-up within 10 minutes of the last turn continues the current session;
//  - later, a fresh session starts;
//  - "go back to …" resumes a past one (with `claude --resume`), "switch to the … project"
//    starts one in that project folder.
// Every session is recorded in the history store, titled after its first turn and
// summarised when Jarvis moves on from it.

const IDLE_MS = 10 * 60_000;
// Every keyword of "go back to <description>" must appear somewhere in the session;
// anything weaker is treated as a normal request ("continue the story").
const MIN_RESUME_COVERAGE = 1;

export type SessionManagerDeps = {
  history: HistoryStore;
  newClaude: (opts: { cwd: string; resume?: string }) => ClaudeSession;
  ask?: Ask; // titles and summaries; skipped when absent
  defaultCwd: string;
  projectsDir: string;
  onChange?: (session: SessionRecord) => void;
  now?: () => number;
  idleMs?: number;
};

export class SessionManager {
  private deps: SessionManagerDeps;
  private current: { record: SessionRecord; claude: ClaudeSession } | undefined;
  private background: Promise<unknown>[] = [];

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  get record(): SessionRecord | undefined {
    return this.current && this.deps.history.get(this.current.record.id);
  }

  get claude(): ClaudeSession | undefined {
    return this.current?.claude;
  }

  // The session for the next request, applying the 10-minute rule.
  forTurn(): ClaudeSession {
    const record = this.record;
    const idle = record && record.turns > 0 && this.now() - record.lastActiveAt > (this.deps.idleMs ?? IDLE_MS);
    if (!this.current || idle) this.startNew(this.current?.record.cwd ?? this.deps.defaultCwd);
    return this.current!.claude;
  }

  // Start Claude Code ahead of the first question.
  prepare(): void {
    this.forTurn().warm();
  }

  startNew(cwd = this.deps.defaultCwd): SessionRecord {
    this.finishCurrent();
    const record = this.deps.history.createSession(cwd, basename(cwd), this.now());
    this.current = { record, claude: this.deps.newClaude({ cwd }) };
    this.current.claude.warm();
    this.deps.onChange?.(record);
    return record;
  }

  resume(record: SessionRecord): void {
    this.finishCurrent();
    const claude = this.deps.newClaude({ cwd: record.cwd, resume: record.claudeSessionId ?? undefined });
    this.current = { record, claude };
    claude.warm();
    this.deps.onChange?.(record);
  }

  // A past session matching a spoken description, other than the current one.
  findSession(query: string): SessionRecord | undefined {
    const best = this.deps.history
      .findSessions(query)
      .find((m) => m.session.id !== this.current?.record.id);
    return best && best.coverage >= MIN_RESUME_COVERAGE ? best.session : undefined;
  }

  // A folder under projectsDir whose name matches what was said ("payments platform").
  findProject(spoken: string): string | undefined {
    const wanted = normalize(spoken);
    if (!wanted) return undefined;
    let best: { path: string; score: number } | undefined;
    for (const name of readdirSync(this.deps.projectsDir)) {
      const path = join(this.deps.projectsDir, name);
      if (name.startsWith(".") || !isDirectory(path)) continue;
      const have = normalize(name);
      const score = have === wanted ? 3 : have.startsWith(wanted) || wanted.startsWith(have) ? 2 : have.includes(wanted) ? 1 : 0;
      if (score > (best?.score ?? 0)) best = { path, score };
    }
    return best?.path;
  }

  recordTurn(user: string, reply: string, tools: string[], claudeSessionId: string | undefined): void {
    const record = this.current?.record;
    if (!record) return;
    this.deps.history.addTurn(record.id, user, reply, tools, this.now());
    if (claudeSessionId) this.deps.history.update(record.id, { claudeSessionId });
    const updated = this.deps.history.get(record.id)!;
    if (updated.turns === 1 && !updated.title) this.titleLater(updated);
    this.deps.onChange?.(updated);
  }

  close(): void {
    this.current?.claude.close();
    this.current = undefined;
  }

  // For tests and shutdown: wait for pending titles and summaries.
  async settle(): Promise<void> {
    await Promise.allSettled(this.background);
  }

  private finishCurrent(): void {
    if (!this.current) return;
    this.current.claude.close();
    const record = this.deps.history.get(this.current.record.id);
    this.current = undefined;
    if (record && record.turns > 0) this.summarizeLater(record);
  }

  private titleLater(record: SessionRecord): void {
    const ask = this.deps.ask;
    if (!ask) return;
    const [first] = this.deps.history.transcript(record.id);
    this.track(
      ask(
        "Give a 3 to 6 word title for the conversation on stdin, like a chat title. Reply with only the title, no quotes.",
        `User: ${first.user}\nAssistant: ${first.reply.slice(0, 1500)}`,
      ).then((title) => {
        this.deps.history.update(record.id, { title: title.replace(/^["']|["'.]$/g, "").slice(0, 80) });
        if (this.current?.record.id === record.id) this.deps.onChange?.(this.deps.history.get(record.id)!);
      }),
    );
  }

  private summarizeLater(record: SessionRecord): void {
    const ask = this.deps.ask;
    if (!ask) return;
    const text = this.deps.history
      .transcript(record.id)
      .map((t) => `User: ${t.user}\nAssistant: ${t.reply.slice(0, 1500)}`)
      .join("\n\n")
      .slice(-12_000);
    this.track(
      ask(
        "Summarize the conversation on stdin in 2 or 3 plain sentences for someone looking back at it later: " +
          "what it was about, what was decided, and anything left open. Reply with only the summary.",
        text,
      ).then((summary) => this.deps.history.update(record.id, { summary })),
    );
  }

  private track(work: Promise<unknown>): void {
    // A failed title or summary only costs a nicer label; never let it surface as a crash.
    this.background.push(work.catch(() => {}));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
