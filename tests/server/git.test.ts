import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeDir } from '../helpers.js';
import {
  branches,
  createWorktree,
  countOf,
  isInside,
  GitError,
  GitRefusal,
  retryWhileBusy,
  headOf,
  removeWorktree,
  runGit,
  samePath,
  switchBranch,
  withoutProgress,
  worktreeStatus,
  worktreesOf,
} from '../../src/server/git.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'first');
}

describe('samePath', () => {
  it.runIf(process.platform === 'win32')('ignores case, separators and a trailing slash on Windows', () => {
    expect(samePath('C:/repos/a', 'c:\\repos\\a\\')).toBe(true);
  });
  it('tells different paths apart', () => {
    expect(samePath('/a/b', '/a/c')).toBe(false);
  });
});

describe('withoutProgress', () => {
  it('drops the progress git reports while it checks files out, and keeps what it says', () => {
    const stderr =
      "Preparing worktree (checking out 'big')\nUpdating files:   2% (1383/47376)\rUpdating files:  60% (28426/47376)\rfatal: unable to write file a.txt\n";
    expect(withoutProgress(stderr)).toBe("Preparing worktree (checking out 'big')\nfatal: unable to write file a.txt");
  });
  it('leaves an ordinary message as it is', () => {
    expect(withoutProgress("fatal: 'x' is already checked out at 'C:/r/x'\n")).toBe("fatal: 'x' is already checked out at 'C:/r/x'");
    expect(withoutProgress('')).toBe('');
  });
});

describe.runIf(hasGit)('runGit', () => {
  it('says that git ran out of time, not what it had printed until then', async () => {
    // Reading from a standard input that never ends: git is still there when the time is up.
    const error = await runGit(['hash-object', '--stdin'], process.cwd(), { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toBe('git hash-object did not finish within 1 second and was stopped.');
  });
});

describe('isInside', () => {
  it('is true for the folder itself and below it', () => {
    expect(isInside('/r/app', '/r/app/')).toBe(true);
    expect(isInside('/r/app/src/web', '/r/app')).toBe(true);
  });
  it('is false for a sibling with the same prefix and outside', () => {
    expect(isInside('/r/app-two', '/r/app')).toBe(false);
    expect(isInside('/r', '/r/app')).toBe(false);
  });
  it.runIf(process.platform === 'win32')('ignores case and separators on Windows', () => {
    expect(isInside('c:\\R\\App\\src', 'C:/r/app')).toBe(true);
  });
});

describe('countOf', () => {
  it('says one or many', () => {
    expect(countOf(1, 'commit', 'commits')).toBe('1 commit');
    expect(countOf(2, 'commit', 'commits')).toBe('2 commits');
  });
});

describe.skipIf(!hasGit)('git worktrees', () => {
  let root = '';
  let repo = '';
  let wtDir = '';
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shellyard-git-')));
    repo = join(root, 'repo');
    wtDir = join(root, 'wt');
    makeRepo(repo);
  });
  afterEach(() => removeDir(root));

  it('worktreesOf returns null outside a repository', async () => {
    expect(await worktreesOf(join(root))).toBeNull();
  });

  it('lists the main worktree and a linked one', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    const l = await worktreesOf(repo);
    expect(l!.worktrees.length).toBe(2);
    expect(l!.worktrees[0]!.isMain).toBe(true);
    expect(l!.worktrees[0]!.branch).toBe('main');
    expect(l!.worktrees[1]!.branch).toBe('feat');
    expect(samePath(l!.worktrees[1]!.path, wtDir)).toBe(true);
    expect(l!.worktrees[1]!.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('current is the worktree a sub-folder belongs to', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    mkdirSync(join(wtDir, 'sub'));
    const l = await worktreesOf(join(wtDir, 'sub'));
    expect(samePath(l!.current, wtDir)).toBe(true);
  });

  it('reports a detached worktree with branch null', async () => {
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    const l = await worktreesOf(repo);
    const w = l!.worktrees.find((x) => samePath(x.path, det))!;
    expect(w.branch).toBeNull();
  });

  it('marks a worktree whose folder is gone as prunable', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    rmSync(wtDir, { recursive: true, force: true });
    const l = await worktreesOf(repo);
    expect(l!.worktrees.find((x) => samePath(x.path, wtDir))!.prunable).toBe(true);
  });

  it('headOf reads the branch of the main and of a linked worktree', () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    expect(headOf(repo)!.branch).toBe('main');
    expect(headOf(repo)!.head).toMatch(/^[0-9a-f]{7}$/);
    expect(headOf(wtDir)!.branch).toBe('feat');
    git(wtDir, 'switch', '-c', 'other');
    expect(headOf(wtDir)!.branch).toBe('other');
  });

  it('headOf reports a detached worktree and null outside a repository', () => {
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    const h = headOf(det)!;
    expect(h.branch).toBeNull();
    expect(h.head).toHaveLength(7);
    expect(headOf(root)).toBeNull();
  });

  it('headOf finds a branch that only packed-refs knows', () => {
    git(repo, 'pack-refs', '--all');
    const h = headOf(repo)!;
    expect(h.branch).toBe('main');
    expect(h.head).toMatch(/^[0-9a-f]{7}$/);
  });

  it('worktreeStatus tells clean, dirty and unreachable commits', async () => {
    expect(await worktreeStatus(repo)).toEqual({ dirty: false, unreachable: 0 });
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect((await worktreeStatus(repo)).dirty).toBe(true);
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    writeFileSync(join(det, 'b.txt'), 'b');
    git(det, 'add', '.');
    git(det, 'commit', '-m', 'second');
    expect(await worktreeStatus(det)).toEqual({ dirty: false, unreachable: 1 });
  });

  it('branches lists local branches', async () => {
    git(repo, 'branch', 'feat');
    const b = await branches(repo);
    expect(b).toContain('main');
    expect(b).toContain('feat');
  });

  it('creates a worktree on a new branch from a base', async () => {
    const l = await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true, base: 'main' });
    expect(l.worktrees.some((w) => w.branch === 'feat' && samePath(w.path, wtDir))).toBe(true);
    expect(headOf(wtDir)!.branch).toBe('feat');
  });

  it('creates a worktree for an existing branch', async () => {
    git(repo, 'branch', 'feat');
    const l = await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: false });
    expect(l.worktrees.some((w) => w.branch === 'feat')).toBe(true);
  });

  it('creates a worktree for a branch with a slash in a folder with a space', async () => {
    const p = join(root, 'my repo-feature-x');
    await createWorktree(repo, { path: p, branch: 'feature/x', newBranch: true });
    expect(headOf(p)!.branch).toBe('feature/x');
  });

  it('refuses a relative path', async () => {
    await expect(createWorktree(repo, { path: 'rel/wt', branch: 'feat', newBranch: true })).rejects.toBeInstanceOf(GitError);
    expect(await branches(repo)).not.toContain('feat');
  });

  it('refuses an existing non-empty folder', async () => {
    mkdirSync(wtDir);
    writeFileSync(join(wtDir, 'f.txt'), 'x');
    await expect(createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true })).rejects.toBeInstanceOf(GitError);
    expect(await branches(repo)).not.toContain('feat');
  });

  it('refuses a branch starting with - and an invalid branch name', async () => {
    await expect(createWorktree(repo, { path: wtDir, branch: '-x', newBranch: true })).rejects.toBeInstanceOf(GitError);
    await expect(createWorktree(repo, { path: wtDir, branch: 'a..b', newBranch: true })).rejects.toBeInstanceOf(GitError);
    expect((await worktreesOf(repo))!.worktrees.length).toBe(1);
  });

  it('refuses to remove the main worktree', async () => {
    await expect(removeWorktree(repo, repo, { force: true, deleteBranch: false })).rejects.toBeInstanceOf(GitError);
  });

  it('refuses to remove a path that is not a worktree of the repository', async () => {
    await expect(removeWorktree(repo, root, { force: true, deleteBranch: false })).rejects.toBeInstanceOf(GitError);
  });

  it('refuses to remove a worktree with changes unless forced', async () => {
    await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
    writeFileSync(join(wtDir, 'new.txt'), 'x');
    await expect(removeWorktree(repo, wtDir, { force: false, deleteBranch: false })).rejects.toBeInstanceOf(GitError);
    const r = await removeWorktree(repo, wtDir, { force: true, deleteBranch: false });
    expect(r.listing.worktrees.length).toBe(1);
  });

  it('removes the branch too when asked', async () => {
    await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
    const r = await removeWorktree(repo, wtDir, { force: false, deleteBranch: true });
    expect(r.warning).toBeNull();
    expect(await branches(repo)).not.toContain('feat');
  });

  it('keeps the worktree removed and warns when the branch is not merged', async () => {
    await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
    writeFileSync(join(wtDir, 'b.txt'), 'b');
    git(wtDir, 'add', '.');
    git(wtDir, 'commit', '-m', 'second');
    const r = await removeWorktree(repo, wtDir, { force: false, deleteBranch: true });
    expect(r.warning).not.toBeNull();
    expect(r.listing.worktrees.length).toBe(1);
    expect(await branches(repo)).toContain('feat');
  });

  it('removes a prunable worktree by pruning', async () => {
    await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
    rmSync(wtDir, { recursive: true, force: true });
    const r = await removeWorktree(repo, wtDir, { force: false, deleteBranch: false });
    expect(r.listing.worktrees.length).toBe(1);
  });

  it('switches a worktree to an existing and to a new branch', async () => {
    git(repo, 'branch', 'other');
    await switchBranch(repo, { branch: 'other', create: false });
    expect(headOf(repo)!.branch).toBe('other');
    await switchBranch(repo, { branch: 'brand-new', create: true });
    expect(headOf(repo)!.branch).toBe('brand-new');
  });

  it("reports git's refusal when the branch is checked out elsewhere", async () => {
    await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
    await expect(switchBranch(repo, { branch: 'feat', create: false })).rejects.toThrow(/already|used by worktree/i);
  });

  it('refuses to lose commits only a detached HEAD holds unless forced', async () => {
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    // Nothing on no branch yet: removed without force.
    await removeWorktree(repo, det, { force: false, deleteBranch: false });
    git(repo, 'worktree', 'add', '--detach', det);
    for (const n of ['b', 'c']) {
      writeFileSync(join(det, `${n}.txt`), n);
      git(det, 'add', '.');
      git(det, 'commit', '-m', n);
    }
    await expect(removeWorktree(repo, det, { force: false, deleteBranch: false })).rejects.toThrow('2 commits on no branch would be lost.');
    await expect(removeWorktree(repo, det, { force: false, deleteBranch: false })).rejects.toBeInstanceOf(GitRefusal);
    expect((await worktreesOf(repo))!.worktrees.length).toBe(2);
    const r = await removeWorktree(repo, det, { force: true, deleteBranch: false });
    expect(r.listing.worktrees.length).toBe(1);
  });

  it('says "1 commit" when one commit would be lost', async () => {
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    writeFileSync(join(det, 'b.txt'), 'b');
    git(det, 'add', '.');
    git(det, 'commit', '-m', 'b');
    await expect(removeWorktree(repo, det, { force: false, deleteBranch: false })).rejects.toThrow('1 commit on no branch would be lost.');
  });

  describe('when git fails half-way (Windows, folder held by another process)', () => {
    // What git does then: the files are gone and the worktree is out of its list, but it fails
    // on the folder itself, which remains.
    const halfDone = (path: string) => async (args: string[], cwd: string): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        git(cwd, 'worktree', 'remove', '--force', '--', path);
        mkdirSync(path);
        throw new GitError(`error: failed to delete '${path}': Permission denied`);
      }
      return git(cwd, ...args);
    };

    it('finishes the removal: deletes the leftover folder and the branch, without a warning', async () => {
      await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
      const r = await removeWorktree(repo, wtDir, { force: false, deleteBranch: true }, { run: halfDone(wtDir) });
      expect(r.warning).toBeNull();
      expect(r.listing.worktrees.length).toBe(1);
      expect(existsSync(wtDir)).toBe(false);
      expect(await branches(repo)).not.toContain('feat');
    });

    it('warns when the leftover folder cannot be deleted, and still deletes the branch', async () => {
      await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
      const r = await removeWorktree(repo, wtDir, { force: false, deleteBranch: true }, { run: halfDone(wtDir), removeFolder: () => false });
      expect(r.warning).toBe(`The folder ${wtDir} could not be fully deleted; remove it by hand.`);
      expect(r.listing.worktrees.length).toBe(1);
      expect(await branches(repo)).not.toContain('feat');
    });

    it("rethrows git's error when the worktree is still listed", async () => {
      await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
      const failing = async (args: string[], cwd: string): Promise<string> => {
        if (args[1] === 'remove') throw new GitError('error: failed to delete: Permission denied');
        return git(cwd, ...args);
      };
      await expect(removeWorktree(repo, wtDir, { force: false, deleteBranch: true }, { run: failing })).rejects.toThrow('Permission denied');
      expect(await branches(repo)).toContain('feat');
    });

    it.runIf(process.platform === 'win32')('copes with a folder really held as the working folder of a process', async () => {
      await createWorktree(repo, { path: wtDir, branch: 'feat', newBranch: true });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: wtDir, stdio: 'ignore' });
      // Listened for from the start: the process may end before the cleanup (it may fail to start).
      const exited = new Promise((r) => child.once('exit', r));
      try {
        await new Promise((r) => setTimeout(r, 300));
        const r = await removeWorktree(repo, wtDir, { force: false, deleteBranch: true });
        expect(r.listing.worktrees.length).toBe(1);
        expect(await branches(repo)).not.toContain('feat');
        // The folder is either gone or reported.
        if (existsSync(wtDir)) expect(r.warning).toMatch(/could not be fully deleted/);
      } finally {
        // The folder is free only once the process has really ended, not when it is told to.
        child.kill();
        await exited;
      }
    });
  });

  it('marks the entry of a bare repository', async () => {
    const bare = join(root, 'app.git');
    git(root, 'clone', '--bare', repo, bare);
    git(bare, 'worktree', 'add', join(root, 'wt'), '-b', 'x');
    const l = await worktreesOf(join(root, 'wt'));
    expect(l!.worktrees.length).toBe(2);
    expect(l!.worktrees[0]).toMatchObject({ isMain: true, bare: true, branch: null });
    expect(samePath(l!.worktrees[0]!.path, bare)).toBe(true);
    expect(l!.worktrees[1]).toMatchObject({ isMain: false, bare: false, branch: 'x' });
  });

  it('marks no entry of a normal repository as bare', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    expect((await worktreesOf(repo))!.worktrees.every((w) => !w.bare)).toBe(true);
  });
});

describe('retryWhileBusy', () => {
  const noWait = async (): Promise<void> => undefined;

  it('retries a folder still in use until git succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await retryWhileBusy(
      async () => {
        calls += 1;
        if (calls < 3) throw new GitError("error: failed to delete 'C:/r/app-x': Permission denied");
        return 'done';
      },
      { attempts: 5, delayMs: 400, sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
    expect(waits).toEqual([400, 400]);
  });

  it('gives up after the last attempt with git\'s error', async () => {
    let calls = 0;
    const busy = (): Promise<never> => {
      calls += 1;
      return Promise.reject(new GitError('Device or resource busy'));
    };
    await expect(retryWhileBusy(busy, { attempts: 5, delayMs: 1, sleep: noWait })).rejects.toThrow('Device or resource busy');
    expect(calls).toBe(5);
  });

  it('does not retry a refusal, nor a git error that is not about a busy folder', async () => {
    let calls = 0;
    await expect(
      retryWhileBusy(() => {
        calls += 1;
        return Promise.reject(new GitRefusal('The main worktree cannot be removed'));
      }, { sleep: noWait }),
    ).rejects.toThrow('The main worktree cannot be removed');
    await expect(
      retryWhileBusy(() => {
        calls += 1;
        return Promise.reject(new GitError("fatal: 'x' contains modified or untracked files, use --force to delete it"));
      }, { sleep: noWait }),
    ).rejects.toThrow('contains modified');
    expect(calls).toBe(2);
  });

  it('does not retry messages that are not about a busy folder', async () => {
    for (const message of ['fatal: unable to read tree', 'error: Directory not empty']) {
      let calls = 0;
      await expect(
        retryWhileBusy(() => {
          calls += 1;
          return Promise.reject(new GitError(message));
        }, { sleep: noWait }),
      ).rejects.toThrow(message);
      expect(calls, message).toBe(1);
    }
  });
});
