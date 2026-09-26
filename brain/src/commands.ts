// Voice commands about sessions, recognised before anything goes to Claude.
// Anything that isn't one of these is a normal request for the current session.

export type Command =
  | { kind: "new" } // "new session", "start over"
  | { kind: "resume"; query: string } // "go back to the auth refactor"
  | { kind: "project"; name: string } // "switch to the payments platform project"
  | { kind: "recall"; query: string } // "what did we decide about the voice?"
  | { kind: "list" } // "what have we been working on?"
  | { kind: "none" };

const NEW = /^(?:let's\s+)?(?:new (?:session|conversation|chat)|fresh start|start over|start (?:a )?(?:new|fresh) (?:session|conversation|chat))\b/i;
const PROJECT = /^(?:let's\s+)?(?:switch|change|go|move|jump)(?: over)? to (?:the |my |our )?(.+?) (?:project|repo|repository|codebase|folder)\W*$/i;
const PROJECT_OPEN = /^(?:let's\s+)?(?:open|work on) (?:the |my |our )?(.+?) (?:project|repo|repository|codebase)\W*$/i;
const RESUME = /^(?:let's\s+)?(?:go back to|back to|return to|resume|pick up|continue(?: with)?)(?: where we left off (?:on|with))? (?:the |our |that |my )?(.+?)(?: (?:conversation|session|chat|discussion|thread))?\W*$/i;
const RECALL = /^(?:remind me\s+)?what (?:(?:did|have|had) )?(?:we|i) (?:decide|decided|discuss|discussed|say|said|talk about|talked about|conclude|concluded|agree|agreed|settle|settled)(?: on)? (?:about |on |regarding |for |with )?(.+?)\W*$/i;
const LIST = /^(?:what (?:have|were|are) we (?:been )?(?:working on|doing|talking about)|(?:list|show)(?: me)? (?:my |our |the )?(?:recent )?(?:sessions|conversations|chats)|what(?:'s| is) running)\b/i;

export function parseCommand(text: string): Command {
  const t = text.trim();
  if (NEW.test(t)) return { kind: "new" };
  if (LIST.test(t)) return { kind: "list" };
  let m = PROJECT.exec(t) ?? PROJECT_OPEN.exec(t);
  if (m) return { kind: "project", name: m[1] };
  m = RECALL.exec(t);
  if (m) return { kind: "recall", query: m[1] };
  m = RESUME.exec(t);
  // "continue" alone, or "continue the story", only resumes if a past session matches (see sessions.ts).
  if (m) return { kind: "resume", query: m[1] };
  return { kind: "none" };
}
