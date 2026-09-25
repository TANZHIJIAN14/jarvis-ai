import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Jarvis's index of past conversations. Claude Code's own transcript stays the full record;
// this keeps what makes voice history easy to browse and search: titles, summaries, and what
// was said and spoken each turn. Node's built-in SQLite has no FTS5, so search scores keywords
// in JavaScript; a personal history is small enough for that.

export type SessionRecord = {
  id: number;
  claudeSessionId: string | null;
  title: string | null;
  summary: string | null;
  project: string; // folder name, e.g. "jarvis-ai"
  cwd: string;
  startedAt: number;
  lastActiveAt: number;
  turns: number;
};

export type TurnRecord = {
  sessionId: number;
  at: number;
  user: string;
  reply: string;
  tools: string[];
};

const STOPWORDS = new Set(("a an and are about did do does for from had has have how i in is it its me my of on or our " +
  "that the their them this to was we were what when where which who why with you your us let's lets back go " +
  "continue resume conversation session chat discussion talk talked decide decided say said").split(" "));

export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

export class HistoryStore {
  private db: DatabaseSync;

  // ":memory:" for tests.
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY,
        claude_session_id TEXT,
        title TEXT,
        summary TEXT,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        at INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        reply_text TEXT NOT NULL,
        tools TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, at);
    `);
  }

  createSession(cwd: string, project: string, now = Date.now()): SessionRecord {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO sessions (project, cwd, started_at, last_active_at) VALUES (?, ?, ?, ?)")
      .run(project, cwd, now, now);
    return this.get(Number(lastInsertRowid))!;
  }

  update(id: number, fields: { claudeSessionId?: string; title?: string; summary?: string }): void {
    const columns = { claudeSessionId: "claude_session_id", title: "title", summary: "summary" } as const;
    for (const [key, column] of Object.entries(columns)) {
      const value = fields[key as keyof typeof fields];
      if (value !== undefined) this.db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, id);
    }
  }

  addTurn(sessionId: number, user: string, reply: string, tools: string[], now = Date.now()): void {
    this.db
      .prepare("INSERT INTO turns (session_id, at, user_text, reply_text, tools) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, now, user, reply, JSON.stringify(tools));
    this.db.prepare("UPDATE sessions SET last_active_at = ?, turns = turns + 1 WHERE id = ?").run(now, sessionId);
  }

  get(id: number): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  // Most recently active first; empty sessions (started but never used) are skipped.
  recent(limit = 10): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE turns > 0 ORDER BY last_active_at DESC LIMIT ?")
      .all(limit)
      .map(toSession);
  }

  transcript(sessionId: number): TurnRecord[] {
    return this.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY at").all(sessionId).map(toTurn);
  }

  // Sessions best matching a spoken description ("the auth refactor", "the kokoro voice").
  // `coverage` is the share of the description's keywords found anywhere in the session.
  findSessions(query: string, limit = 3): Array<{ session: SessionRecord; score: number; coverage: number }> {
    const words = keywords(query);
    if (words.length === 0) return [];
    const scored = this.db
      .prepare("SELECT * FROM sessions WHERE turns > 0")
      .all()
      .map(toSession)
      .map((session) => {
        const turnsText = this.transcript(session.id).map((t) => `${t.user} ${t.reply}`).join(" ");
        const perWord = words.map((w) =>
          3 * count(session.title, w) + 3 * count(session.project, w) + 2 * count(session.summary, w)
            + Math.min(3, count(turnsText, w)));
        const score = perWord.reduce((a, b) => a + b, 0);
        return { session, score, coverage: perWord.filter((x) => x > 0).length / words.length };
      })
      .filter((s) => s.score > 0);
    return scored
      .sort((a, b) => b.coverage - a.coverage || b.score - a.score || b.session.lastActiveAt - a.session.lastActiveAt)
      .slice(0, limit);
  }

  // Past turns relevant to a question ("what did we decide about the voice?").
  searchTurns(query: string, limit = 5): Array<{ turn: TurnRecord; session: SessionRecord; score: number }> {
    const words = keywords(query);
    if (words.length === 0) return [];
    const like = words.map(() => "(user_text LIKE ? OR reply_text LIKE ?)").join(" OR ");
    const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
    return this.db
      .prepare(`SELECT * FROM turns WHERE ${like} ORDER BY at DESC LIMIT 200`)
      .all(...params)
      .map(toTurn)
      .map((turn) => ({
        turn,
        session: this.get(turn.sessionId)!,
        score: words.reduce((sum, w) => sum + Math.min(3, count(`${turn.user} ${turn.reply}`, w)), 0),
      }))
      .sort((a, b) => b.score - a.score || b.turn.at - a.turn.at)
      .slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}

function count(text: string | null, word: string): number {
  if (!text) return 0;
  return text.toLowerCase().split(word).length - 1;
}

function toSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: Number(row.id),
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    project: String(row.project),
    cwd: String(row.cwd),
    startedAt: Number(row.started_at),
    lastActiveAt: Number(row.last_active_at),
    turns: Number(row.turns),
  };
}

function toTurn(row: Record<string, unknown>): TurnRecord {
  return {
    sessionId: Number(row.session_id),
    at: Number(row.at),
    user: String(row.user_text),
    reply: String(row.reply_text),
    tools: JSON.parse(String(row.tools)) as string[],
  };
}
