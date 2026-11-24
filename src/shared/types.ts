export type SessionKind = 'claude' | 'shell';
export type Status = 'idle' | 'working' | 'attention' | 'running' | 'exited';
export type Reason = 'blocked' | 'finished' | 'maybe-waiting' | null;
export type HookName = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop' | 'PermissionRequest';

export const HOOK_NAMES: readonly HookName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'PermissionRequest',
];

/**
 * What a blocked session is asking. A permission names the tool and what it would act on
 * (the command, the file); a question carries Claude Code's message or the question itself.
 * Any part may be missing: older Claude Code versions say only that they wait.
 */
export interface PendingRequest {
  /** New for every request, so that an answer meant for an earlier one is refused. */
  id: string;
  kind: 'permission' | 'question';
  tool: string | null;
  detail: string | null;
  message: string | null;
  since: number;
}

/**
 * How the user answers a permission from outside the terminal. "area" allows it once and adds
 * a rule, so that the sessions of the same area run such commands without asking again.
 */
export type PermissionChoice = 'once' | 'deny' | 'area';

/** A state on the timeline: "needs" blocked on the user, "maybe" possibly waiting. */
export type FlowState = 'needs' | 'maybe' | 'working' | 'finished' | 'idle';

export interface FlowSegment {
  state: FlowState;
  from: number;
  /** Null while it lasts. */
  to: number | null;
}

/** How the day went for the user: what waited on them, and how fast they answered. */
export interface FlowDay {
  /** Time Claude sessions spent blocked on the user (permission or question). */
  blockedMs: number;
  /** How long the user took to answer each block that ended in an answer. */
  medianAnswerMs: number | null;
  answers: number;
  /** How many sessions worked at once, on average, while any did. */
  parallel: number | null;
}

export interface FlowSummary {
  today: FlowDay;
  /** The average of the previous seven days that had any activity; null when there were none. */
  previous: { blockedMs: number; medianAnswerMs: number | null } | null;
  /** The last hour, per Claude session, oldest segment first. */
  timeline: { from: number; to: number; sessions: Array<{ id: string; name: string; segments: FlowSegment[] }> };
}

/** A Bash command the sessions of an area may run without asking (see shared/rules.ts). */
export interface AreaRule {
  id: string;
  storyId: string;
  /** Words of a command, "*" last for any further arguments: "dotnet test *". */
  pattern: string;
  enabled: boolean;
  createdAt: number;
  /** How many requests it answered in the last 7 days: interruptions avoided. */
  weekHits: number;
}

/**
 * What is behind the text of a terminal: a colour, or an uploaded image (by the name ShellYard
 * stored it under) with a dark veil over it, 0 for none to nearly 1 for almost black.
 */
export interface TerminalBackground {
  color: string | null;
  image: string | null;
  veil: number;
}

/** The font of a terminal. A null part is left to the default (Cascadia Mono, 13). */
export interface TerminalFont {
  family: string | null;
  /** In pixels. */
  size: number | null;
}

/** A named group of sessions, typically one piece of work. An empty string means "not set". */
export interface Story {
  id: string;
  name: string;
  ticket: string;
  cwd: string;
  color: string;
  /** Id of an uploaded sound played for this area; '' means none. */
  sound: string;
}

/** An uploaded sound; id is '<uuid>.<ext>'. */
export interface SoundFile {
  id: string;
  name: string;
  /** The part of the file that plays, in seconds: from start, to end (null: the end of the file). */
  start: number;
  end: number | null;
}

/** Which sound plays for each event; null means the chime. */
export interface SoundSettings {
  blocked: string | null;
  finished: string | null;
  maybeWaiting: string | null;
}

export interface SoundLibrary {
  sounds: SoundFile[];
  settings: SoundSettings;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  storyId: string | null;
  name: string;
  color: string;
  cwd: string;
  command: string;
  args: string[];
  model: string | null;
  status: Status;
  reason: Reason;
  statusSince: number;
  cols: number;
  rows: number;
  exitCode: number | null;
  error: string | null;
  /** True when the session continues a Claude Code conversation that already existed. */
  resumed: boolean;
  /** Null: the terminal follows the theme. */
  background: TerminalBackground | null;
  /** The font and text size chosen for this terminal; null: the default. */
  font: TerminalFont | null;
  /** The git worktree the session works in; null outside a repository or before git answered. */
  git: SessionGit | null;
  /** For a Claude session, the folder Claude reports it is working in now. */
  liveCwd: string | null;
  /** While the session is blocked: what it asks, as far as Claude Code said. */
  pending: PendingRequest | null;
}

export interface SessionGit {
  worktree: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  worktreeCount: number;
}

/** A Claude Code conversation saved on disk, which can be continued in a new session. */
export interface Conversation {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

/** A session that ended or was closed, and can be opened again in its area. */
export interface ClosedSession {
  id: string;
  /** The session it came from. */
  sessionId: string;
  closedAt: number;
  kind: SessionKind;
  name: string;
  color: string;
  cwd: string;
  storyId: string | null;
  /** True if reopening continues a Claude Code conversation; false if it starts afresh. */
  resumes: boolean;
}

export interface ConversationItem extends Conversation {
  /** The session in which this conversation is open here, if it is. */
  openIn: string | null;
}

export interface Profile {
  id: string;
  name: string;
  kind: SessionKind;
  command: string;
  args: string[];
  cwd: string;
  color: string;
  env: Record<string, string>;
  model: string | null;
  /** The background its sessions start with; absent or null: the theme's. */
  background?: TerminalBackground | null;
  /** The font and text size its sessions start with; absent or null: the default. */
  font?: TerminalFont | null;
}

export interface CreateSessionRequest {
  profileId?: string;
  kind?: SessionKind;
  command?: string;
  args?: string[];
  name?: string;
  cwd?: string;
  color?: string;
  model?: string | null;
  storyId?: string | null;
  /** The id of a saved Claude Code conversation to continue. */
  resume?: string;
  /** Overrides the profile's background; null asks for the theme's. */
  background?: TerminalBackground | null;
  /** Overrides the profile's font; null asks for the default. */
  font?: TerminalFont | null;
}

export interface Meta {
  profiles: Profile[];
  models: string[];
  /** Ids of the profiles kept in the config file: the user's own, and changed built-ins. */
  saved: string[];
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: Array<{ name: string; path: string }>;
  roots: string[];
}

/** How much of a plan limit is used, and when it resets (milliseconds since the epoch). */
export interface LimitReading {
  usedPercentage: number;
  resetsAt: number;
}

export interface UsageLine {
  key: string;
  label: string;
  tokensIn: number;
  tokensOut: number;
  /** Claude Code's own estimate of what this would cost at API prices. */
  costUsd: number;
}

export interface UsagePeriod {
  costUsd: number;
  byModel: UsageLine[];
  byStory: UsageLine[];
}

export interface UsageSummary {
  limits: { fiveHour: LimitReading | null; sevenDay: LimitReading | null; readAt: number | null };
  /** Today, the last 7 days and the last 30 days, each including today. */
  today: UsagePeriod;
  week: UsagePeriod;
  month: UsagePeriod;
}

export type ClientMessage =
  | { t: 'attach'; id: string; cols: number; rows: number }
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number };

/** When a schedule runs. Times are the local time of the machine ShellYard runs on. */
export type ScheduleWhen =
  | { kind: 'once'; at: number }
  /** `time` is "HH:MM"; `days` are weekdays, 0 for Sunday to 6 for Saturday. */
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'interval'; minutes: number }
  /** Five fields: minute, hour, day of month, month, weekday. */
  | { kind: 'cron'; expr: string };

/**
 * How a scheduled session asks before acting. "default" passes nothing, so Claude Code uses
 * the mode it is set up with. The modes that never ask are deliberately not offered.
 */
export const SCHEDULE_PERMISSION_MODES = ['default', 'manual', 'acceptEdits', 'auto', 'plan'] as const;
export type SchedulePermissionMode = (typeof SCHEDULE_PERMISSION_MODES)[number];

/**
 * started: the session is open and the prompt is on its way; delivered: Claude Code took the
 * prompt; undelivered: the session is open but the prompt did not get in; failed: no session
 * could be started; skipped: the run did not happen.
 */
export type ScheduleOutcome = 'started' | 'delivered' | 'undelivered' | 'failed' | 'skipped';

export interface ScheduleRun {
  at: number;
  outcome: ScheduleOutcome;
  detail: string | null;
  sessionId: string | null;
  /** True for a run asked for by hand. */
  manual: boolean;
  /**
   * When the run ended, for a run that ended while ShellYard followed it ('turn' or 'session');
   * null otherwise. With `at`, how long the run took.
   */
  finishedAt: number | null;
  /** How the run ended (see RunEnd); null while it runs, or when it never had a session at work. */
  endedBy: RunEnd | null;
  /** Claude Code's estimate of what the run's session cost until it finished; null when unknown. */
  costUsd: number | null;
  /** How long the run waited on the user (a permission or a question), in all. */
  blockedMs: number;
  /** Since when it waits on the user now; null when it does not. */
  blockedSince: number | null;
  /**
   * When its wait of now was found longer than the schedules allow (SCHEDULE_STUCK_AFTER_MS);
   * null when it does not wait, or not that long yet. Each wait is reported on its own.
   */
  stuckAt: number | null;
}

/**
 * How a scheduled run ended. 'turn': Claude Code finished its turn after the prompt. 'session':
 * the session ended or was closed before that. 'restart': ShellYard stopped while it ran; a
 * session comes back as a new one, so the run could not be followed further. 'unknown': it was
 * saved before ShellYard followed runs.
 */
export type RunEnd = 'turn' | 'session' | 'restart' | 'unknown';

/** How long a scheduled run may wait on the user before it is reported as stuck. */
export const SCHEDULE_STUCK_AFTER_MS = 10 * 60 * 1000;

/** A prompt given to a new Claude Code session at set times. */
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  profileId: string;
  /**
   * What the launcher ran when the schedule was last saved (a digest of its kind, command,
   * arguments and environment). A run whose launcher has changed since is refused: nobody is
   * at the screen to see that it now starts something else. Null: no such launcher then.
   */
  launcher: string | null;
  /** Null: the profile's own model. */
  model: string | null;
  /** Empty: the folder of the area, or else of the profile. */
  cwd: string;
  storyId: string | null;
  when: ScheduleWhen;
  enabled: boolean;
  /** Whether a run missed while ShellYard was not running is made up for at the next start. */
  catchUp: boolean;
  permissionMode: SchedulePermissionMode;
  createdAt: number;
  /** Null when it will not run again by itself. */
  nextRunAt: number | null;
  /** Newest first. */
  runs: ScheduleRun[];
}

/** Where an error happened: in the server, in the page, or while ShellYard was starting. */
export type ErrorSource = 'server' | 'page' | 'startup';

/** An unexpected error, written to a file of its own so that it can be read or sent on. */
export interface ErrorReport {
  id: string;
  source: ErrorSource;
  /** The first line of the error, with secrets taken out. */
  message: string;
  /** What was being done: an API route, a background task, the page's address. */
  context: string | null;
  /** The full path of the report file. */
  file: string;
  at: number;
  /** The same error happened this many times in this run; the file says when. */
  count: number;
  lastAt: number;
  /** True once the user has closed its notice. */
  seen: boolean;
}

/** An address of this computer on a local network, with the name of its network adapter. */
export interface LanAddress {
  name: string;
  ip: string;
}

/** Phone access: a second listener on the local network, off unless the user turns it on. */
export interface LanStatus {
  enabled: boolean;
  /** The port it listens on (when off, the one it will try first). */
  port: number;
  /** This computer's addresses on private networks, the likeliest (Wi-Fi, Ethernet) first. */
  addresses: LanAddress[];
  /** Pages connected through it right now. */
  clients: number;
  /** Changes whenever the link changes (a new link, a new port), so a shown QR code can be refreshed. */
  revision: number;
}

/** The status plus the links themselves, which carry the token: only answered to a page that asks. */
export interface LanInfo extends LanStatus {
  /** Per address: `url` opens ShellYard (with the token), `setupUrl` installs the root on a new phone. */
  links: Array<LanAddress & { url: string; setupUrl: string }>;
  /** The root each phone trusts once, as its settings will show it. */
  certificate: { name: string; fingerprint: string };
}

export type ServerMessage =
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'schedules'; schedules: Schedule[] }
  | { t: 'stories'; stories: Story[] }
  | { t: 'rules'; rules: AreaRule[] }
  | { t: 'closed'; closed: ClosedSession[] }
  | { t: 'usage'; usage: UsageSummary }
  /** Bytes printed in the last second, per session; sessions printing nothing are absent. */
  | { t: 'activity'; rates: Record<string, number> }
  /** The errors of this run, newest first. */
  | { t: 'errors'; errors: ErrorReport[] }
  /** The uncommitted changes of the worktrees sessions work in; a worktree without any is absent. */
  | { t: 'changes'; changes: ChangeSummary[] }
  /** Whether phone access is on, where, and how many phones are connected. Never carries the link. */
  | { t: 'lan'; lan: LanStatus }
  /** The screen of a session, and the size it was taken at. */
  | { t: 'snapshot'; id: string; data: string; cols: number; rows: number }
  | { t: 'output'; id: string; data: string }
  /** The session has this size from this point of its output on. */
  | { t: 'size'; id: string; cols: number; rows: number };

export interface Worktree {
  path: string;
  /** Null when the worktree is detached. */
  branch: string | null;
  /** The checked-out commit, shortened to 7 characters. */
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  /** The entry of a bare repository: no files checked out, nothing to work in. */
  bare: boolean;
}

/**
 * How git sees a file that differs from the last commit. A rename shows as the old path deleted
 * and the new one added; "conflicted" is a file left by a merge that is not resolved.
 */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'typechange' | 'conflicted';

/** A file of a worktree that is not as the last commit has it. */
export interface ChangedFile {
  /** Relative to the top of the worktree, with forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Lines added and removed; null for a binary file, or one too large to count. */
  added: number | null;
  removed: number | null;
}

/** The uncommitted changes of a worktree: everything not as the last commit has it. */
export interface WorktreeChanges {
  worktree: string;
  files: ChangedFile[];
  added: number;
  removed: number;
  /** True when there were more files than are listed. */
  truncated: boolean;
}

/** The changes of a worktree in figures, for the badge of the sessions working in it. */
export interface ChangeSummary {
  worktree: string;
  files: number;
  added: number;
  removed: number;
}

/** What changed in one file, as a unified diff against the last commit. */
export interface FileDiff {
  path: string;
  status: ChangeStatus;
  binary: boolean;
  /** True when the diff is too long to show; `diff` is then empty. */
  tooLarge: boolean;
  diff: string;
}

export interface WorktreeListing {
  /** The worktree the asked folder belongs to. */
  current: string;
  worktrees: Worktree[];
}
