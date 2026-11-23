import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PtySession, realPtyFactory } from '../../src/server/pty-session.js';
import { toLaunch } from '../../src/server/shells.js';
import { fakePtyFactory, waitUntil } from '../helpers.js';

const launch = { file: 'x', args: [] };
const opts = { cwd: process.cwd(), env: {}, cols: 80, rows: 24 };

describe('PtySession with a fake pty', () => {
  it('forwards output to subscribers in order', () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    const seen: string[] = [];
    s.onOutput((d) => seen.push(d));
    f.last().emit('a');
    f.last().emit('b');
    f.last().emit('c');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('restores earlier output in a snapshot', async () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    f.last().emit('hello\r\nworld');
    const snap = (await s.snapshot()).data;
    expect(snap).toContain('hello');
    expect(snap).toContain('world');
  });

  it('gives a snapshot with the size the screen had when it was taken', async () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    const before = s.snapshot();
    s.resize(100, 30);
    expect(await before).toMatchObject({ cols: 100, rows: 30 });
    const after = s.snapshot();
    expect(await after).toMatchObject({ cols: 100, rows: 30 });
  });

  it('keeps the mirror capped when output far exceeds the scrollback', async () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    const seen: string[] = [];
    s.onOutput((d) => seen.push(d));
    for (let i = 0; i < 10_000; i++) f.last().emit(`line-${i}\r\n`);
    const snap = (await s.snapshot()).data;
    const lines = snap.split('\r\n');
    expect(lines.length).toBeLessThanOrEqual(5000 + 24 + 1);
    expect(snap).toContain('line-9999');
    expect(snap).not.toContain('line-100\r');
    expect(seen).toHaveLength(10_000);
    expect(seen[9999]).toBe('line-9999\r\n');
  });

  it('ignores a resize to a degenerate size', () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    s.resize(0, 0);
    s.resize(1, 10);
    s.resize(Number.NaN, 10);
    expect(f.last().resizes).toEqual([]);
    expect([s.cols, s.rows]).toEqual([80, 24]);
  });

  it('applies a real resize to the pty and to itself', () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    s.resize(100, 30);
    expect(f.last().resizes).toEqual([[100, 30]]);
    expect([s.cols, s.rows]).toEqual([100, 30]);
  });

  it('does not resize again to the same size', () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    s.resize(80, 24);
    expect(f.last().resizes).toEqual([]);
  });

  it('passes input through', () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    s.write('ls\r');
    expect(f.last().written).toEqual(['ls\r']);
  });

  it('reports the exit code once and stops touching the pty afterwards', () => {
    const f = fakePtyFactory();
    const s = new PtySession(f.factory, launch, opts);
    const codes: number[] = [];
    s.onExit((c) => codes.push(c));
    f.last().exit(3);
    s.write('late');
    s.resize(90, 20);
    s.kill();
    expect(codes).toEqual([3]);
    expect(f.last().written).toEqual([]);
    expect(f.last().resizes).toEqual([]);
    expect(f.last().killed).toBe(false);
  });

  it('lets the factory error reach the caller', () => {
    expect(
      () =>
        new PtySession(
          () => {
            throw new Error('spawn failed');
          },
          launch,
          opts,
        ),
    ).toThrow('spawn failed');
  });
});

describe.skipIf(process.platform !== 'win32')('a .cmd shim on Windows, through a real pty', () => {
  it('runs from a folder with a space in its name and receives arguments with spaces intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellyard shim '));
    try {
      const shim = join(dir, 'echoargs.cmd');
      writeFileSync(shim, '@echo off\r\necho ARGS:%*\r\n');
      const s = new PtySession(realPtyFactory, toLaunch(shim, ['--settings', join(dir, 's.json'), 'plain'], 'win32'), {
        cwd: dir,
        env: process.env as Record<string, string>,
        cols: 200,
        rows: 24,
      });
      let out = '';
      s.onOutput((d) => (out += d));
      let exited = false;
      s.onExit(() => (exited = true));
      await waitUntil(() => exited, 10000);
      expect(out).not.toMatch(/is not recognized/);
      expect(out).toContain(`ARGS:--settings "${join(dir, 's.json')}" plain`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes characters cmd.exe acts on as plain text, through the script as well', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellyard-meta-'));
    try {
      const shim = join(dir, 'echoargs.cmd');
      writeFileSync(shim, '@echo off\r\necho ARGS:%*\r\n');
      const s = new PtySession(realPtyFactory, toLaunch(shim, ['a&echo INJECTED', '%USERNAME%', 'x|y', '(z)'], 'win32'), {
        cwd: dir,
        env: process.env as Record<string, string>,
        cols: 200,
        rows: 24,
      });
      let out = '';
      s.onOutput((d) => (out += d));
      let exited = false;
      s.onExit(() => (exited = true));
      await waitUntil(() => exited, 10000);
      expect(out).toContain('ARGS:"a&echo INJECTED" %USERNAME% x|y (z)');
      expect(out).not.toMatch(/^INJECTED/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PtySession with a real pty', () => {
  it('runs a process, sends it input and reads its output', async () => {
    const script = "process.stdin.on('data',d=>process.stdout.write('got:'+d))";
    const s = new PtySession(
      realPtyFactory,
      { file: process.execPath, args: ['-e', script] },
      { cwd: process.cwd(), env: process.env as Record<string, string>, cols: 80, rows: 24 },
    );
    let out = '';
    s.onOutput((d) => (out += d));
    // Give the child a moment to attach its stdin listener before typing.
    await new Promise((r) => setTimeout(r, 800));
    s.write('ping\r');
    await waitUntil(() => out.includes('got:ping'), 8000);
    let exited = false;
    s.onExit(() => (exited = true));
    s.kill();
    await waitUntil(() => exited, 8000);
  });
});
