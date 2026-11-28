import { suggestPattern } from '../shared/rules.js';
import type { SessionInfo } from '../shared/types.js';

/** What a waiting session wants, as the board and the answer queue show it. */
export type RequestKind = 'permission' | 'question' | 'maybe' | 'finished';

/** Meant for a session that waits (status "attention"). */
export function requestKind(s: SessionInfo): RequestKind {
  if (s.reason === 'finished') return 'finished';
  if (s.reason === 'maybe-waiting') return 'maybe';
  return s.pending?.kind === 'question' ? 'question' : 'permission';
}

export const REQUEST_BADGE: Record<RequestKind, string> = {
  permission: 'Permission',
  question: 'Question',
  maybe: 'Possibly waiting',
  finished: 'Finished',
};

/** Whether the request on screen can be allowed or denied from outside the terminal. */
export function answerable(s: SessionInfo): boolean {
  // Only a request shown in full: one known only from the notification says no command.
  return s.status === 'attention' && s.reason === 'blocked' && s.pending?.kind === 'permission' && !!s.pending.detail;
}

/**
 * The rule "Always in this area" would add for the request on screen, to show it; null where
 * the choice does not exist (not a Bash command, no area, a command that can never be a rule).
 * The server makes the rule itself, from the command as Claude Code sent it.
 */
export function areaRuleFor(s: SessionInfo, areaIds: ReadonlySet<string>): string | null {
  const p = s.pending;
  if (!answerable(s) || p?.tool !== 'Bash' || !p.detail || !s.storyId || !areaIds.has(s.storyId)) return null;
  // A command shortened for display cannot be judged here; the server still can.
  if (p.detail.endsWith('…')) return null;
  return suggestPattern(p.detail);
}

/** "Allow this command in C:\repos\project?": what the terminal asks, in a line. */
export function askLine(s: SessionInfo): string {
  const tool = s.pending?.tool;
  const what = tool === 'Bash' ? 'this command' : tool ? `${tool} here` : 'this';
  return `Allow ${what} in ${s.liveCwd ?? s.cwd}?`;
}

/** The short line under a name in the queue: "Permission · dotnet test", "Question · Which version?". */
export function requestSummary(s: SessionInfo): string {
  const kind = requestKind(s);
  const p = s.pending;
  const what = kind === 'permission' || kind === 'question' ? (p?.detail ?? p?.message ?? null) : null;
  return what ? `${REQUEST_BADGE[kind]} · ${what}` : REQUEST_BADGE[kind];
}
