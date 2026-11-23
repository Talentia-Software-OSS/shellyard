import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Worktree, WorktreeListing } from '../shared/types.js';
import { removeDirPatiently } from './remove-dir.js';

/**
 * The message is git's trimmed stderr, or a validation message. `code` is the code of the
 * error git was run with, when there is one (for instance ERR_CHILD_PROCESS_STDIO_MAXBUFFER).
 */
export class GitError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
  ) {
    super(message);
  }
}

/** Git did not finish in the time it was given, and was stopped where it was. */
export class GitTimeout extends GitError {}

/** A request this module turns down itself (main worktree, not a worktree, bad name...): never worth retrying. */
export class GitRefusal extends GitError {}

/**
 * What git says when a folder is still held by a process that is going away (Windows keeps the
 * cwd of a dying process busy for a moment): "Permission denied", "Device or resource busy",
 * "being used by another process", "failed to delete". Git runs with LC_ALL=C, so it is English.
 */
const BUSY = /busy|permission denied|being used|failed to delete/i;

/**
 * Runs a git operation again, a few times and a short while apart, while it fails because a folder
 * is busy. Refusals and other git errors (like changes that need force) are thrown at once.
 */
export async function retryWhileBusy<T>(
  fn: () => Promise<T>,
  o: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = o.attempts ?? 5;
  const delayMs = o.delayMs ?? 400;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      const busy = e instanceof GitError && !(e instanceof GitRefusal) && BUSY.test(e.message);
      if (!busy || i >= attempts) throw e;
      await sleep(delayMs);
    }
  }
}

const TIMEOUT_MS = 15000;
/**
 * For the commands that write the files of a worktree: checking out a large repository takes
 * minutes, not seconds, and git stopped half-way leaves a worktree that is neither there nor gone.
 */
export const CHECKOUT_TIMEOUT_MS = 15 * 60 * 1000;

export type RunGit = (args: string[], cwd: string) => Promise<string>;

/** A line git writes to say how far it is ("Updating files:  12% (5686/47376)"), not what went wrong. */
const PROGRESS = /^[^:]+:\s+\d+% \(\d+\/\d+\)/;

/** What git wrote to stderr, without its progress reports (which it separates with carriage returns). */
export function withoutProgress(stderr: string): string {
  return stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !PROGRESS.test(line))
    .join('\n');
}

/**
 * Runs git without a shell and returns stdout. Throws GitError when git fails, is missing, or
 * does not finish in time. Git speaks English here (LC_ALL=C), so that its messages can be recognised.
 */
export function runGit(args: string[], cwd: string, o: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code ?? undefined;
          // Node stops a git that runs past the timeout; what git had printed until then is not an error.
          if (error.killed && code === undefined) {
            reject(new GitTimeout(`git ${args[0]} did not finish within ${countOf(Math.round(timeoutMs / 1000), 'second', 'seconds')} and was stopped.`));
            return;
          }
          const printed = String(stderr ?? '');
          // Node's own message repeats all that git printed, progress included: it is used
          // only when git printed nothing (it is missing, or could not be started).
          const fallback = printed.trim() ? `git ${args[0]} failed${typeof code === 'number' ? ` (exit ${code})` : ''}` : error.message;
          reject(new GitError(withoutProgress(printed) || fallback, code));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

let gitAvailable: Promise<boolean> | null = null;

export function hasGit(): Promise<boolean> {
  gitAvailable ??= runGit(['--version'], process.cwd()).then(
    () => true,
    () => false,
  );
  return gitAvailable;
}

function normalise(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, '');
  const slashed = r.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

export function samePath(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

/** Whether `folder` is `root` or somewhere below it. */
export function isInside(folder: string, root: string): boolean {
  const f = normalise(folder);
  const r = normalise(root);
  return f === r || f.startsWith(r.endsWith('/') ? r : `${r}/`);
}

function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    let w: Worktree | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        w = {
          path: resolve(line.slice('worktree '.length)),
          branch: null,
          head: '',
          isMain: list.length === 0,
          locked: false,
          prunable: false,
          bare: false,
        };
      } else if (!w) continue;
      else if (line.startsWith('HEAD ')) w.head = line.slice(5, 12);
      else if (line.startsWith('branch ')) w.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'locked' || line.startsWith('locked ')) w.locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) w.prunable = true;
      else if (line === 'bare') w.bare = true;
    }
    if (w) list.push(w);
  }
  return list;
}

/** The worktrees of the repository a folder belongs to, or null when it is in none (or git is missing). */
export async function worktreesOf(folder: string): Promise<WorktreeListing | null> {
  try {
    const top = (await runGit(['rev-parse', '--show-toplevel'], folder)).trim();
    const worktrees = parseWorktrees(await runGit(['worktree', 'list', '--porcelain'], folder));
    if (worktrees.length === 0) return null;
    return { current: resolve(top), worktrees };
  } catch {
    return null;
  }
}

function gitDirOf(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    return isAbsolute(m[1]!) ? m[1]! : resolve(worktreePath, m[1]!);
  } catch {
    return null;
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function resolveRef(gitDir: string, ref: string): string {
  const direct = readIfExists(join(gitDir, ref));
  if (direct !== null) return direct.trim().slice(0, 7);
  // A linked worktree keeps its refs in the common directory.
  const common = readIfExists(join(gitDir, 'commondir'));
  const commonDir = common ? resolve(gitDir, common.trim()) : gitDir;
  if (commonDir !== gitDir) {
    const shared = readIfExists(join(commonDir, ref));
    if (shared !== null) return shared.trim().slice(0, 7);
  }
  const packed = readIfExists(join(commonDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      const m = /^([0-9a-f]{40,64}) (.+)$/.exec(line);
      if (m && m[2] === ref) return m[1]!.slice(0, 7);
    }
  }
  return '';
}

/** What a worktree has checked out, read from files only, so it is cheap enough to call often. */
export function headOf(worktreePath: string): { branch: string | null; head: string } | null {
  const gitDir = gitDirOf(worktreePath);
  if (!gitDir || !existsSync(gitDir)) return null;
  const text = readIfExists(join(gitDir, 'HEAD'))?.trim();
  if (!text) return null;
  const m = /^ref:\s*(.+)$/.exec(text);
  if (m) {
    const ref = m[1]!.trim();
    return { branch: ref.replace(/^refs\/heads\//, ''), head: resolveRef(gitDir, ref) };
  }
  return { branch: null, head: text.slice(0, 7) };
}

/** Whether a worktree has uncommitted changes, and how many commits only a detached HEAD holds. */
export async function worktreeStatus(
  worktreePath: string,
): Promise<{ dirty: boolean; unreachable: number }> {
  const dirty = (await runGit(['status', '--porcelain'], worktreePath)).trim().length > 0;
  let unreachable = 0;
  if (headOf(worktreePath)?.branch === null) {
    const n = await runGit(
      ['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes'],
      worktreePath,
    );
    unreachable = Number.parseInt(n.trim(), 10) || 0;
  }
  return { dirty, unreachable };
}

/** The local branches of the repository a folder belongs to; empty outside one. */
export async function branches(folder: string): Promise<string[]> {
  try {
    const out = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], folder);
    return out.split(/\r?\n/).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function refuseDash(label: string, value: string): void {
  if (value.startsWith('-')) throw new GitRefusal(`${label} must not start with "-"`);
}

/** Returns the name when git accepts it as a branch name; throws GitError otherwise. */
export async function validateBranch(folder: string, name: string): Promise<string> {
  if (name.length === 0) throw new GitRefusal('Branch name is empty');
  refuseDash('Branch name', name);
  await runGit(['check-ref-format', '--branch', name], folder);
  return name;
}

async function listingOf(repo: string): Promise<WorktreeListing> {
  const listing = await worktreesOf(repo);
  if (!listing) throw new GitRefusal('Not a git repository');
  return listing;
}

export async function createWorktree(
  repo: string,
  o: { path: string; branch: string; newBranch: boolean; base?: string },
): Promise<WorktreeListing> {
  if (!isAbsolute(o.path)) throw new GitRefusal('The worktree path must be absolute');
  refuseDash('Path', o.path);
  await validateBranch(repo, o.branch);
  const base = o.base ?? 'HEAD';
  refuseDash('Base', base);
  if (existsSync(o.path)) {
    let entries: string[];
    try {
      entries = readdirSync(o.path);
    } catch {
      throw new GitRefusal('The worktree path exists and is not a folder');
    }
    if (entries.length > 0) throw new GitRefusal('The worktree folder already exists and is not empty');
  }
  // Quiet: the progress of the checkout has nowhere to be shown, and it is not an error.
  const args = o.newBranch
    ? ['worktree', 'add', '--quiet', '-b', o.branch, '--', o.path, base]
    : ['worktree', 'add', '--quiet', '--', o.path, o.branch];
  try {
    await runGit(args, repo, { timeoutMs: CHECKOUT_TIMEOUT_MS });
  } catch (e) {
    // Git stopped half-way has listed the worktree (and made the branch) already, so the same
    // request would be refused next time. It is not undone here: that deletes files.
    if (!(e instanceof GitTimeout)) throw e;
    const left = o.newBranch ? `the worktree ${o.path} and the new branch ${o.branch}` : `the worktree ${o.path}`;
    throw new GitTimeout(`${e.message} It left ${left} incomplete: remove ${o.newBranch ? 'them' : 'it'} before trying again.`);
  }
  return listingOf(repo);
}

/** "1 commit", "2 commits". */
export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Deletes what is left of a folder, trying again for a few seconds while it is busy; true when it is gone. */
function removeLeftover(path: string): Promise<boolean> {
  return removeDirPatiently(path, { timeoutMs: 3000 });
}

/**
 * Removes a linked worktree (and, when asked, its branch if it is merged). `seams` lets tests
 * stand in for git and for the deletion of a leftover folder.
 */
export async function removeWorktree(
  repo: string,
  path: string,
  o: { force: boolean; deleteBranch: boolean },
  seams: { run?: RunGit; removeFolder?: (path: string) => boolean | Promise<boolean> } = {},
): Promise<{ listing: WorktreeListing; warning: string | null }> {
  const run = seams.run ?? runGit;
  refuseDash('Path', path);
  const target = (await listingOf(repo)).worktrees.find((w) => samePath(w.path, path));
  if (!target) throw new GitRefusal('Not a worktree of this repository');
  if (target.isMain) throw new GitRefusal('The main worktree cannot be removed');
  // Removing a worktree drops its HEAD: commits only a detached HEAD holds would be lost.
  if (!o.force && target.branch === null && !target.prunable) {
    const { unreachable } = await worktreeStatus(target.path);
    if (unreachable > 0) throw new GitRefusal(`${countOf(unreachable, 'commit', 'commits')} on no branch would be lost.`);
  }
  const warnings: string[] = [];
  if (target.prunable) await run(['worktree', 'prune'], repo);
  else {
    try {
      await run(['worktree', 'remove', ...(o.force ? ['--force'] : []), '--', target.path], repo);
    } catch (e) {
      // On Windows git can fail half-way on a folder another process still holds: it has deleted
      // the files and dropped the worktree from its list already, and only the folder remains.
      // The removal is done then; what is left of the folder is deleted here if it can be.
      const still = (await listingOf(repo)).worktrees.some((w) => samePath(w.path, target.path));
      if (still) throw e;
      if (existsSync(target.path) && !(await (seams.removeFolder ?? removeLeftover)(target.path))) {
        warnings.push(`The folder ${target.path} could not be fully deleted; remove it by hand.`);
      }
    }
  }
  if (o.deleteBranch && target.branch) {
    try {
      await run(['branch', '-d', '--', target.branch], repo);
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { listing: await listingOf(repo), warning: warnings.length > 0 ? warnings.join('\n') : null };
}

export async function switchBranch(
  worktreePath: string,
  o: { branch: string; create: boolean },
): Promise<void> {
  await validateBranch(worktreePath, o.branch);
  await runGit(['switch', ...(o.create ? ['-c'] : []), o.branch], worktreePath);
}
