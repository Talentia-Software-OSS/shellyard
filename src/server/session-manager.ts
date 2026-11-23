import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import type { Conversation, SessionGit, WorktreeListing, CreateSessionRequest, HookName, PermissionChoice, Profile, SessionInfo, SessionKind, Story, TerminalBackground, TerminalFont } from '../shared/types.js';
import { normalizeBackground } from './backgrounds.js';
import { normalizeFont } from './fonts.js';
import { findConversation } from './conversations.js';
import type { RestoreEntry } from './restore.js';
import { cleanupClaudeLaunch, prepareClaudeLaunch, withoutClaudeSessionMarkers, type HookRequest } from './claude-launch.js';
import type { Config } from './config.js';
import { headOf, isInside, samePath, worktreesOf } from './git.js';
import { isTerminalReport } from './input.js';
import { PtySession, type PtyFactory, type Snapshot } from './pty-session.js';
import { applyOrder } from './order.js';
import { detectProfiles, resolveExecutable, toLaunch } from './shells.js';
import { initialState, reduce, type StatusEvent } from './state.js';
import { pasteOf } from './prompt-delivery.js';
import { promptRefusal, type PromptRefusal } from '../shared/sessions.js';

/** Between the paste of a prompt and Enter, so that Claude Code has taken the paste in as one piece. */
const PROMPT_ENTER_DELAY_MS = 400;

export interface ManagerDeps {
  ptyFactory: PtyFactory;
  now: () => number;
  config: () => Config;
  port: number;
  hookToken: string;
  hookScriptPath: string;
  statusScriptPath: string;
  /** Profiles offered without configuration. Defaults to what is installed on this machine. */
  builtins?: () => Profile[];
  /** The current stories, to validate a session's story and borrow its folder and colour. */
  stories?: () => Story[];
  /** Looks up a saved Claude Code conversation. Defaults to reading Claude Code's own files. */
  findConversation?: (id: string) => Conversation | null;
  /** Reads the git worktrees around a folder. Defaults to running git. */
  gitOf?: (folder: string) => Promise<WorktreeListing | null>;
  /** Reads the branch and commit of a worktree. Defaults to reading its HEAD file. */
  headOf?: (worktree: string) => { branch: string | null; head: string } | null;
}

const CLAUDE_PROFILE = 'builtin-claude';
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_COLOR = '#888888';
/** Output arriving this soon after the user typed is taken to be the echo of that typing. */
const ECHO_WINDOW_MS = 500;
/**
 * Output arriving this soon after a resize is taken to be the program repainting. Showing a
 * waiting session resizes its terminal, so without this the repaint would read as "it is
 * working again" and the session would drop out of sight just as it was put on screen.
 */
const REPAINT_WINDOW_MS = 1500;
/** A stopped process not reported gone after this long is not waited for any more. */
const DYING_MS = 10000;

interface Entry {
  info: SessionInfo;
  pty: PtySession | null;
  lastOutputAt: number;
  lastInputAt: number;
  lastResizeAt: number;
  profileId: string | null;
  /** The model asked for at launch; info.model may later show what Claude Code reports. */
  launchModel: string | null;
  /** For a Claude session, the conversation it holds, as far as is known. */
  conversationId: string | null;
  /** Counts git lookups, so that only the latest one started is applied. */
  gitSeq: number;
  /** Counts the processes started, so that the callbacks of a replaced one are ignored. */
  generation: number;
  /** Conversations replaced by restartIn: late reports naming them come from a stopped process. */
  retired: Set<string>;
  /** The environment the launcher adds to every start of this session. */
  env: Record<string, string>;
  /** A question Claude announced (PreToolUse of AskUserQuestion), shown once it blocks on it. */
  asked: HookRequest | null;
  /** The raw command of the permission request on screen, kept off the info the page gets. */
  pendingCommand: { requestId: string; command: string | null } | null;
  /** Claude Code has drawn its main screen (its first status line came): typing now reaches it. */
  ready: boolean;
}

/**
 * The keys that answer Claude Code's permission menu: Enter takes "Yes", the first choice and
 * the one selected when the menu opens; Escape refuses. "area" is "Yes" here; the rule it adds
 * is ShellYard's own.
 */
const ANSWER_KEYS: Record<PermissionChoice, string> = { once: '\r', area: '\r', deny: '\x1b' };

export type AnswerOutcome = 'answered' | 'stale' | 'missing';

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a session working in `cwd` should start in another worktree: the same sub-folder of
 * `to` when `cwd` is inside the worktree `from` and that sub-folder exists, else `to` itself.
 */
export function mapIntoWorktree(cwd: string, from: string, to: string, exists: (p: string) => boolean = isDirectory): string {
  const parts: string[] = [];
  let dir = cwd;
  while (!samePath(dir, from)) {
    const parent = dirname(dir);
    if (parent === dir) return to;
    parts.unshift(basename(dir));
    dir = parent;
  }
  if (parts.length === 0) return to;
  const sep = to.includes('\\') ? '\\' : '/';
  const candidate = to.replace(/[\\/]+$/, '') + sep + parts.join(sep);
  return exists(candidate) ? candidate : to;
}

function sameGit(a: SessionGit | null, b: SessionGit | null): boolean {
  if (!a || !b) return a === b;
  return a.worktree === b.worktree && a.branch === b.branch && a.head === b.head && a.isMain === b.isMain && a.worktreeCount === b.worktreeCount;
}

export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly changeCbs: Array<(sessions: SessionInfo[]) => void> = [];
  private readonly outputCbs: Array<(id: string, data: string) => void> = [];
  private readonly closedCbs: Array<(entry: RestoreEntry, sessionId: string) => void> = [];
  /** Processes stopped (session closed or restarted elsewhere) that have not ended yet, with their folders. */
  private readonly dying = new Set<{ folders: string[]; since: number }>();

  constructor(private readonly deps: ManagerDeps) {}

  /**
   * Stops a session's process. Until it has ended its folders count as in use, as Windows keeps
   * the working folder of a process busy until it is gone.
   */
  private stop(entry: Entry): void {
    const pty = entry.pty;
    entry.pty = null;
    if (!pty) return;
    if (!pty.hasExited) {
      const { info } = entry;
      const record = {
        folders: [info.cwd, info.liveCwd, info.git?.worktree].filter((f): f is string => typeof f === 'string'),
        since: this.deps.now(),
      };
      this.dying.add(record);
      pty.onExit(() => this.dying.delete(record));
    }
    pty.kill();
    pty.dispose();
  }

  /** Whether a process of a session, running or still ending, works in this folder or below it. */
  hasLiveProcessIn(folder: string): boolean {
    const now = this.deps.now();
    for (const d of this.dying) {
      if (now - d.since > DYING_MS) this.dying.delete(d);
      else if (d.folders.some((f) => isInside(f, folder))) return true;
    }
    for (const e of this.entries.values()) {
      if (!e.pty || e.pty.hasExited || e.info.status === 'exited') continue;
      const folders = [e.info.cwd, e.info.liveCwd, e.info.git?.worktree];
      if (folders.some((f) => typeof f === 'string' && isInside(f, folder))) return true;
    }
    return false;
  }

  list(): SessionInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(id: string): SessionInfo | null {
    const e = this.entries.get(id);
    return e ? { ...e.info } : null;
  }

  /** Puts the sessions in the given order (see applyOrder). */
  reorder(ids: string[]): void {
    const next = applyOrder([...this.entries.values()], ids, (e) => e.info.id);
    this.entries.clear();
    for (const e of next) this.entries.set(e.info.id, e);
    this.emitChange();
  }

  /**
   * All profiles a session can be created from: the user's own first, then the built-in
   * ones. A built-in profile the user has changed keeps its place and shows the saved version.
   */
  profiles(): Profile[] {
    const saved = this.deps.config().profiles;
    const builtins = (this.deps.builtins ?? detectProfiles)();
    const builtinIds = new Set(builtins.map((p) => p.id));
    const own = saved.filter((p) => !builtinIds.has(p.id));
    const all = [...own, ...builtins.map((b) => saved.find((p) => p.id === b.id) ?? b)];
    return applyOrder(all, this.deps.config().profileOrder ?? [], (p) => p.id);
  }

  /**
   * Creates a session. A bad folder, an unknown command or a failed start does not throw:
   * the session is created already exited, carrying the reason, so the UI can show it.
   */
  create(req: CreateSessionRequest): SessionInfo {
    const now = this.deps.now();
    const id = randomUUID();
    let profile: Profile | undefined;
    let problem: string | null = null;

    // Continuing a saved conversation: it decides the folder, and Claude Code runs it.
    let conversation: Conversation | null = null;
    if (req.resume !== undefined) {
      conversation = (this.deps.findConversation ?? findConversation)(req.resume);
      if (!conversation) problem = 'Conversation not found. It may have been deleted, or nothing was ever asked in it.';
      else {
        const openIn = this.openConversations().get(conversation.id);
        const holder = openIn ? this.entries.get(openIn) : undefined;
        if (holder) problem = `This conversation is already open here, in "${holder.info.name}".`;
      }
    }

    const profileId = req.profileId ?? (req.resume !== undefined ? CLAUDE_PROFILE : undefined);
    if (profileId) {
      profile = this.profiles().find((p) => p.id === profileId);
      // A resumed session may name its command itself (when it is brought back after a restart).
      if (!profile && !(req.resume !== undefined && req.command)) problem ??= `Launcher not found: ${profileId}`;
    }

    const kind: SessionKind = req.resume !== undefined ? 'claude' : (req.kind ?? profile?.kind ?? 'shell');
    const command = (req.command ?? profile?.command ?? '').trim();
    const args = req.args ?? profile?.args ?? [];
    const story = req.storyId ? this.story(req.storyId) : undefined;
    // A session started inside a story works in the story's folder unless told otherwise.
    const cwd = conversation?.cwd || (req.cwd ?? '').trim() || story?.cwd || profile?.cwd || homedir();
    const model = kind === 'claude' ? (req.model !== undefined ? req.model : (profile?.model ?? null)) || null : null;
    const name = (req.name ?? '').trim() || conversation?.title.slice(0, 48) || profile?.name || basename(command) || 'session';
    const color = (req.color ?? '').trim() || story?.color || profile?.color || DEFAULT_COLOR;

    const info: SessionInfo = {
      id,
      kind,
      storyId: story?.id ?? null,
      name,
      color,
      cwd,
      command,
      args,
      model,
      ...initialState(kind),
      statusSince: now,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      exitCode: null,
      error: null,
      resumed: false,
      // The request decides if it says anything (null included); otherwise the profile does.
      background: req.background !== undefined ? normalizeBackground(req.background) : normalizeBackground(profile?.background),
      font: req.font !== undefined ? normalizeFont(req.font) : normalizeFont(profile?.font),
      git: null,
      liveCwd: null,
      pending: null,
    };
    const entry: Entry = {
      info,
      pty: null,
      lastOutputAt: now,
      lastInputAt: 0,
      lastResizeAt: 0,
      profileId: profile?.id ?? null,
      launchModel: model,
      // A new Claude session is started under its own id, which is then its conversation's id.
      conversationId: kind === 'claude' ? (conversation?.id ?? id) : null,
      gitSeq: 0,
      generation: 0,
      retired: new Set(),
      env: { ...(profile?.env ?? {}) },
      asked: null,
      pendingCommand: null,
      ready: false,
    };
    this.entries.set(id, entry);

    problem ??= this.start(entry, cwd, conversation?.id ?? null);
    if (!problem) info.resumed = conversation !== null;
    else this.failStart(entry, problem);
    this.emitChange();
    if (!problem) this.refreshGit(id).catch(() => undefined);
    return { ...info };
  }

  /**
   * Starts the process of a session in a folder. Returns why it could not, or null.
   * A Claude session continues `resumeId` if given, else starts its `conversationId`.
   */
  private start(entry: Entry, cwd: string, resumeId: string | null): string | null {
    const { info } = entry;
    const { command, args } = info;
    if (!command) return 'No command was given.';
    if (!isDirectory(cwd)) return `Folder does not exist: ${cwd}`;
    const resolved = resolveExecutable(command);
    if (!resolved) return `Command not found: ${command}`;
    try {
      let launchArgs = args;
      const env: Record<string, string> = { ...withoutClaudeSessionMarkers(process.env), ...entry.env };
      if (info.kind === 'claude') {
        const launch = prepareClaudeLaunch({
          sessionId: info.id,
          port: this.deps.port,
          hookToken: this.deps.hookToken,
          model: entry.launchModel,
          hookScriptPath: this.deps.hookScriptPath,
          statusScriptPath: this.deps.statusScriptPath,
          extraArgs: args,
          resumeId,
          conversationId: entry.conversationId ?? undefined,
        });
        launchArgs = launch.args;
        Object.assign(env, launch.env);
      }
      entry.pty = new PtySession(this.deps.ptyFactory, toLaunch(resolved, launchArgs), {
        cwd,
        env,
        cols: info.cols,
        rows: info.rows,
      });
      this.wire(entry);
      return null;
    } catch (e) {
      return `Could not start ${command}: ${(e as Error).message}`;
    }
  }

  private failStart(entry: Entry, problem: string): void {
    entry.info.status = 'exited';
    entry.info.reason = null;
    entry.info.error = problem;
    cleanupClaudeLaunch(entry.info.id);
  }

  /**
   * Stops a session's process, without reporting it as closed, and starts the same command
   * again in another worktree, keeping the session's id and properties. A Claude session
   * starts a new conversation there. Works on exited sessions too. Null for an unknown id.
   */
  restartIn(id: string, worktree: string): SessionInfo | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { info } = entry;
    const now = this.deps.now();

    // Callbacks of the old process are ignored from here on, its exit included: it must
    // neither close the session nor remove the settings file of the new process.
    entry.generation++;
    this.stop(entry);
    cleanupClaudeLaunch(id);

    const from = info.git?.worktree ?? info.cwd;
    const cwd = mapIntoWorktree(info.liveCwd ?? info.cwd, from, worktree);
    Object.assign(info, initialState(info.kind));
    info.statusSince = now;
    info.exitCode = null;
    info.error = null;
    info.resumed = false;
    info.liveCwd = null;
    info.pending = null;
    entry.asked = null;
    entry.ready = false;
    info.cwd = cwd;
    if (info.kind === 'claude') {
      if (entry.conversationId) entry.retired.add(entry.conversationId);
      entry.conversationId = randomUUID();
      info.model = entry.launchModel;
    }
    entry.lastOutputAt = now;
    entry.lastInputAt = 0;
    entry.lastResizeAt = 0;

    const problem = this.start(entry, cwd, null);
    if (problem) {
      // The session is in another folder now: the git it had no longer describes it.
      entry.gitSeq++;
      info.git = null;
      this.failStart(entry, problem);
    }
    this.emitChange();
    if (!problem) this.refreshGit(id).catch(() => undefined);
    return { ...info };
  }

  /** Works out the git worktree and branch of a session from the folder it is in. */
  async refreshGit(id: string): Promise<void> {
    const e = this.entries.get(id);
    // An exited session keeps the git it last had.
    if (!e || e.info.status === 'exited') return;
    const seq = ++e.gitSeq;
    const folder = e.info.liveCwd ?? e.info.cwd;
    let git: SessionGit | null = null;
    try {
      const listing = await (this.deps.gitOf ?? worktreesOf)(folder);
      if (listing) {
        const w = listing.worktrees.find((x) => samePath(x.path, listing.current));
        if (w) git = { worktree: w.path, branch: w.branch, head: w.head, isMain: w.isMain, worktreeCount: listing.worktrees.length };
      }
    } catch {
      git = null;
    }
    if (this.entries.get(id) !== e || e.gitSeq !== seq) return;
    if (sameGit(e.info.git, git)) return;
    e.info.git = git;
    this.emitChange();
  }

  /** Refreshes every running session working in a worktree of the repository containing this folder. */
  async refreshGitIn(worktreeOrRepo: string): Promise<void> {
    let listing: WorktreeListing | null = null;
    try {
      listing = await (this.deps.gitOf ?? worktreesOf)(worktreeOrRepo);
    } catch {
      return;
    }
    if (!listing) return;
    const paths = listing.worktrees.map((w) => w.path);
    const ids = [...this.entries.values()]
      .filter((e) => e.info.status !== 'exited' && e.info.git && paths.some((p) => samePath(p, e.info.git!.worktree)))
      .map((e) => e.info.id);
    await Promise.all(ids.map((id) => this.refreshGit(id)));
  }

  /** The folder Claude Code says it is working in. Only an existing absolute folder counts. */
  setLiveCwd(id: string, cwd: unknown): void {
    const e = this.entries.get(id);
    if (!e || e.info.kind !== 'claude' || e.info.status === 'exited') return;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !isDirectory(cwd)) return;
    const previous = e.info.liveCwd;
    if (previous !== null && samePath(previous, cwd)) return;
    e.info.liveCwd = cwd;
    this.emitChange();
    this.refreshGit(id).catch(() => undefined);
  }

  /** Re-reads the branch of the running sessions from their HEAD files; no git process. */
  refreshHeads(): void {
    const read = this.deps.headOf ?? headOf;
    let changed = false;
    for (const e of this.entries.values()) {
      const git = e.info.git;
      if (!git || e.info.status === 'exited') continue;
      let h: { branch: string | null; head: string } | null = null;
      try {
        h = read(git.worktree);
      } catch {
        h = null;
      }
      if (!h || (h.branch === git.branch && h.head === git.head)) continue;
      e.info.git = { ...git, branch: h.branch, head: h.head };
      changed = true;
    }
    if (changed) this.emitChange();
  }

  private wire(entry: Entry): void {
    const { pty, info } = entry;
    if (!pty) return;
    const generation = entry.generation;
    pty.onOutput((data) => {
      if (entry.generation !== generation) return;
      if (!this.entries.has(info.id)) return;
      const now = this.deps.now();
      for (const cb of this.outputCbs) cb(info.id, data);
      const echo = now - entry.lastInputAt <= ECHO_WINDOW_MS;
      const repaint = now - entry.lastResizeAt <= REPAINT_WINDOW_MS;
      // Only output the program produced on its own shows that it is busy.
      if (echo || repaint) return;
      entry.lastOutputAt = now;
      this.dispatch(entry, { type: 'output' });
    });
    pty.onExit((code) => {
      // A process replaced by restartIn: the session has moved on to another one.
      if (entry.generation !== generation) return;
      info.exitCode = code;
      cleanupClaudeLaunch(info.id);
      // Removed by the user (reported then) or by the server stopping (not a closing at all).
      if (!this.entries.has(info.id)) return;
      this.emitClosed(entry);
      this.dispatch(entry, { type: 'exit' }, true);
    });
  }

  /** Applies an event; announces a change only if the status actually moved (or when forced). */
  private dispatch(entry: Entry, event: StatusEvent, force = false): void {
    const { info } = entry;
    const next = reduce(info.kind, { status: info.status, reason: info.reason }, event);
    const changed = next.status !== info.status || next.reason !== info.reason;
    if (changed) {
      const now = this.deps.now();
      // Silence is measured from the later of "last output" and "work started", so a
      // session that sat quiet for an hour is not flagged the instant it starts working.
      if (next.status === 'working') entry.lastOutputAt = Math.max(entry.lastOutputAt, now);
      const wasBlocked = info.status === 'attention' && info.reason === 'blocked';
      const nowBlocked = next.status === 'attention' && next.reason === 'blocked';
      info.status = next.status;
      info.reason = next.reason;
      info.statusSince = now;
      // A request lasts until its block ends (answered), or the turn or the session does. Going
      // quiet before the menu shows (working ↔ possibly waiting) does not end it: the menu
      // drawing itself is output, and Claude Code may take a while to say the menu is up.
      const turnOver = next.status === 'idle' || next.status === 'exited' || (next.status === 'attention' && next.reason === 'finished');
      if ((wasBlocked && !nowBlocked) || turnOver) info.pending = null;
    }
    if (changed || force) this.emitChange();
  }

  private story(id: string): Story | undefined {
    return this.deps.stories?.().find((s) => s.id === id);
  }

  /** Ungroups the sessions of a story that is going away. They keep running. */
  clearStory(storyId: string): void {
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.info.storyId === storyId) {
        e.info.storyId = null;
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  update(id: string, patch: { name?: string; color?: string; storyId?: string | null; background?: TerminalBackground | null; font?: TerminalFont | null }): SessionInfo | null {
    const e = this.entries.get(id);
    if (!e) return null;
    // undefined leaves the background alone; null, or one that is not valid, clears it.
    if (patch.background !== undefined) e.info.background = normalizeBackground(patch.background);
    if (patch.font !== undefined) e.info.font = normalizeFont(patch.font);
    // undefined leaves the story as it is; null, or a story that does not exist, ungroups.
    if (patch.storyId !== undefined) e.info.storyId = patch.storyId ? (this.story(patch.storyId)?.id ?? null) : null;
    const name = typeof patch.name === 'string' ? patch.name.trim() : '';
    const color = typeof patch.color === 'string' ? patch.color.trim() : '';
    if (name) e.info.name = name;
    if (color) e.info.color = color;
    this.emitChange();
    return { ...e.info };
  }

  /** Conversation id → the session holding it, for the Claude sessions still running. */
  openConversations(): Map<string, string> {
    const open = new Map<string, string>();
    for (const e of this.entries.values()) {
      if (e.conversationId && e.info.status !== 'exited') open.set(e.conversationId, e.info.id);
    }
    return open;
  }

  /** The conversation a session holds, as far as is known. */
  conversationOf(id: string): string | null {
    return this.entries.get(id)?.conversationId ?? null;
  }

  /** Whether a report naming this conversation comes from a process restartIn has replaced. */
  isRetiredConversation(id: string, conversationId: unknown): boolean {
    if (typeof conversationId !== 'string') return false;
    return this.entries.get(id)?.retired.has(conversationId) ?? false;
  }

  /**
   * The conversation Claude Code says the session is holding (it changes with /clear or /resume).
   * Called for reports not from a retired conversation: the current process is reporting, so the
   * one it replaced is gone, and a retired conversation it names later (/resume) is its own.
   */
  setConversation(id: string, conversationId: string): void {
    const e = this.entries.get(id);
    if (!e || e.info.kind !== 'claude' || !CONVERSATION_ID.test(conversationId)) return;
    e.retired.clear();
    if (e.conversationId === conversationId) return;
    e.conversationId = conversationId;
    this.emitChange();
  }

  /** What is needed to start a session like this one again. */
  private describe(e: Entry): RestoreEntry {
    return {
      kind: e.info.kind,
      profileId: e.profileId,
      name: e.info.name,
      color: e.info.color,
      cwd: e.info.cwd,
      command: e.info.command,
      args: e.info.args,
      storyId: e.info.storyId,
      model: e.launchModel,
      conversationId: e.conversationId,
      background: e.info.background,
      font: e.info.font,
    };
  }

  /** What would be needed to start the running sessions again after a restart. */
  restorable(): RestoreEntry[] {
    return [...this.entries.values()].filter((e) => e.info.status !== 'exited').map((e) => this.describe(e));
  }

  private emitClosed(e: Entry): void {
    const entry = this.describe(e);
    for (const cb of this.closedCbs) cb(entry, e.info.id);
  }

  /**
   * Called when a session that had started comes to an end: its process finished, or the
   * user closed it while it ran. Not called for the sessions the server ends by stopping.
   */
  onClosed(cb: (entry: RestoreEntry, sessionId: string) => void): void {
    this.closedCbs.push(cb);
  }

  /** The model Claude Code says the session is using now (it can change with /model). */
  setModel(id: string, model: string): void {
    const e = this.entries.get(id);
    if (!e || !model || e.info.model === model) return;
    e.info.model = model;
    this.emitChange();
  }

  ack(id: string): SessionInfo | null {
    const e = this.entries.get(id);
    if (!e) return null;
    this.dispatch(e, { type: 'ack' });
    return { ...e.info };
  }

  /**
   * Types a prompt into a Claude session waiting at its prompt: pasted as one piece, then Enter
   * a moment later, as a scheduled run does. Refuses (and types nothing into) a session that is
   * not at its prompt. Enter is pressed only if the same process is still waiting there.
   */
  typePrompt(id: string, prompt: string): 'sent' | 'missing' | 'starting' | PromptRefusal {
    const e = this.entries.get(id);
    if (!e) return 'missing';
    const refusal = promptRefusal(e.info);
    if (refusal) return refusal;
    if (!e.pty) return 'exited';
    // Typed before Claude Code is up, the prompt would be lost while the outcome said "sent".
    if (!e.ready) return 'starting';
    const generation = e.generation;
    this.input(id, pasteOf(prompt));
    setTimeout(() => {
      if (this.entries.get(id) !== e || e.generation !== generation || promptRefusal(e.info)) return;
      this.input(id, '\r');
    }, PROMPT_ENTER_DELAY_MS);
    return 'sent';
  }

  /**
   * `request`: what the hook says the session asks for, if it says (see parseHookRequest).
   * `command`: for a Bash permission, the command exactly as sent (see permissionCommand).
   */
  hook(id: string, name: HookName, idleReminder: boolean, request: HookRequest | null = null, command: string | null = null): boolean {
    const e = this.entries.get(id);
    if (!e || e.info.status === 'exited') return false;
    if (name === 'PreToolUse' && request) e.asked = request;
    else if (name === 'PostToolUse' || name === 'UserPromptSubmit' || name === 'Stop') e.asked = null;
    this.dispatch(e, { type: 'hook', name, idleReminder });
    // A request that never blocked the session was settled without the user (another hook,
    // the permission mode): the session has moved on, and the request with it. While blocked,
    // tool events come from subagents and say nothing about the request on screen.
    const blocked = e.info.status === 'attention' && e.info.reason === 'blocked';
    if (e.info.pending && !blocked && name !== 'PermissionRequest' && name !== 'Notification') {
      e.info.pending = null;
      this.emitChange();
    }
    if (this.notePending(e, name, request)) {
      if (name === 'PermissionRequest' && e.info.pending?.kind === 'permission') e.pendingCommand = { requestId: e.info.pending.id, command };
      this.emitChange();
    }
    return true;
  }

  /** A Claude session reported a status line: its main screen is up. */
  noteStatusLine(id: string): void {
    const e = this.entries.get(id);
    if (e) e.ready = true;
  }

  /** The Bash command of the request on screen, as Claude Code sent it; null once it is gone. */
  pendingCommand(id: string, requestId: string): string | null {
    const e = this.entries.get(id);
    if (!e || e.info.pending?.id !== requestId || e.pendingCommand?.requestId !== requestId) return null;
    return e.pendingCommand.command;
  }

  /**
   * Records what a blocked session asks. A permission request names it fully and replaces what
   * was there; a notification only fills in when nothing is known yet, borrowing the question
   * Claude announced. True when the request shown changed.
   */
  private notePending(e: Entry, name: HookName, request: HookRequest | null): boolean {
    const { info } = e;
    if (!request || info.status === 'exited') return false;
    // Known before the menu shows (it may never show); the page offers answers only once the
    // session is blocked on it, and the next tool event clears it if it was settled elsewhere.
    if (name === 'PermissionRequest') {
      // Another request while one is already waiting (a subagent, parallel tool calls): which
      // menu is on screen can no longer be told from here, so neither is answered from outside.
      // The new id turns away clicks meant for the first one.
      if (info.pending) {
        info.pending = { ...info.pending, kind: 'question', id: randomUUID(), message: 'Several requests are waiting: answer them in the terminal.' };
        e.pendingCommand = null;
        return true;
      }
      info.pending = { ...request, id: randomUUID(), since: this.deps.now() };
      return true;
    }
    if (!(info.status === 'attention' && info.reason === 'blocked')) return false;
    if (name !== 'Notification' || info.pending) return false;
    const asked = request.kind === 'question' ? e.asked : null;
    info.pending = { ...request, ...(asked ? { tool: asked.tool, detail: asked.detail } : {}), id: randomUUID(), since: this.deps.now() };
    return true;
  }

  /**
   * Answers a permission request by pressing the key the terminal's menu expects. Only the
   * request still on screen can be answered: once the user has answered it in the terminal, or
   * another request has come, a late click must not type into whatever is there now.
   */
  answer(id: string, requestId: string, choice: PermissionChoice): AnswerOutcome {
    const e = this.entries.get(id);
    if (!e) return 'missing';
    const p = e.info.pending;
    const blocked = e.info.status === 'attention' && e.info.reason === 'blocked';
    // Only a request the user could read in full: one known only from the notification names no command.
    if (!p || p.id !== requestId || p.kind !== 'permission' || !p.detail || !blocked || !e.pty) return 'stale';
    this.input(id, ANSWER_KEYS[choice]);
    return 'answered';
  }

  input(id: string, data: string): void {
    const e = this.entries.get(id);
    if (!e || !e.pty || e.info.status === 'exited') return;
    e.pty.write(data);
    // Focus reports, cursor-position answers and the like pass through, but they are the
    // terminal talking, not the user responding.
    if (isTerminalReport(data)) return;
    e.lastInputAt = this.deps.now();
    this.dispatch(e, { type: 'input' });
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e || !e.pty) return;
    e.pty.resize(cols, rows);
    if (e.pty.cols !== e.info.cols || e.pty.rows !== e.info.rows) {
      e.lastResizeAt = this.deps.now();
      e.info.cols = e.pty.cols;
      e.info.rows = e.pty.rows;
      this.emitChange();
    }
  }

  async snapshot(id: string): Promise<Snapshot | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    return e.pty ? e.pty.snapshot() : { data: '', cols: e.info.cols, rows: e.info.rows };
  }

  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    // Closed while it was running; one that had already ended was reported when it ended.
    if (e.pty && e.info.status !== 'exited') this.emitClosed(e);
    this.entries.delete(id);
    this.stop(e);
    cleanupClaudeLaunch(id);
    this.emitChange();
    return true;
  }

  /** Flags working sessions whose terminal has gone quiet: they are probably waiting. */
  tick(): void {
    const now = this.deps.now();
    const silenceMs = this.deps.config().silenceMs;
    for (const e of this.entries.values()) {
      if (e.info.status === 'working' && now - e.lastOutputAt >= silenceMs) this.dispatch(e, { type: 'silence' });
    }
  }

  onChange(cb: (sessions: SessionInfo[]) => void): void {
    this.changeCbs.push(cb);
  }

  onOutput(cb: (id: string, data: string) => void): void {
    this.outputCbs.push(cb);
  }

  shutdown(): void {
    for (const [id, e] of [...this.entries]) {
      this.entries.delete(id);
      e.pty?.kill();
      e.pty?.dispose();
      cleanupClaudeLaunch(id);
    }
  }

  private emitChange(): void {
    const sessions = this.list();
    for (const cb of this.changeCbs) cb(sessions);
  }
}
