// What went wrong with a Claude turn, per the design doc's "When things go wrong": only "can't
// reach Claude" is an Error (red orb, low tone, Try again); a usage limit is an ordinary reply.

export type ClaudeProblem =
  | { kind: "unreachable"; reason: "signed_out" | "not_installed" | "offline" | "crashed" }
  | { kind: "limit"; resetAt?: number; resetText?: string }
  | { kind: "other" };

export const NOT_INSTALLED = "The claude command was not found.";
export const CRASHED = "Claude Code stopped unexpectedly.";

export function classifyClaudeError(text: string, now = Date.now()): ClaudeProblem {
  if (text === NOT_INSTALLED) return { kind: "unreachable", reason: "not_installed" };
  if (text === CRASHED) return { kind: "unreachable", reason: "crashed" };
  if (/\blimit\b/i.test(text) && /usage|rate|hour|weekly|hit your|reached/i.test(text)) {
    return { kind: "limit", ...resetTime(text, now) };
  }
  if (/log ?in|sign(ed)? ?(in|out)|auth|credential|unauthori[sz]ed|\b401\b|\b403\b|oauth|token (has )?expired/i.test(text)) {
    return { kind: "unreachable", reason: "signed_out" };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|connection error|unable to connect|offline|fetch failed/i.test(text)) {
    return { kind: "unreachable", reason: "offline" };
  }
  return { kind: "other" };
}

// "…limit reached|1759075200" (epoch seconds) or "…resets 3pm" / "resets at 3:30 PM".
function resetTime(text: string, now: number): { resetAt?: number; resetText?: string } {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    return { resetAt: at, resetText: clock(at) };
  }
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return {};
  let hours = Number(m[1]);
  const half = m[3]?.toLowerCase();
  if (half === "pm" && hours < 12) hours += 12;
  if (half === "am" && hours === 12) hours = 0;
  const at = new Date(now);
  at.setHours(hours, Number(m[2] ?? 0), 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return { resetAt: at.getTime(), resetText: clock(at.getTime()) };
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
}

// What Jarvis says for an Error.
export function unreachableMessage(reason: Extract<ClaudeProblem, { kind: "unreachable" }>["reason"]): string {
  switch (reason) {
    case "signed_out":
      return "I can't reach Claude right now. It looks like you're signed out. Run claude once in Terminal, and I'll try again.";
    case "not_installed":
      return "I can't find Claude Code on this Mac. Install it, run claude once in Terminal, and I'll try again.";
    case "offline":
      return "I can't reach Claude right now. It looks like the connection is down. I'll try again when you're ready.";
    default:
      return "I can't reach Claude right now. Claude Code stopped unexpectedly. Try again, or run claude in Terminal to check.";
  }
}
