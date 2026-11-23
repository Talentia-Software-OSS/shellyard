import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultConfig } from '../../src/server/config.js';
import { join } from 'node:path';
import { ActivityMeter } from '../../src/server/activity.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { UsageStore } from '../../src/server/usage.js';
import { attachWebSocket } from '../../src/server/ws.js';
import type { ServerMessage, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const TOKEN = 't'.repeat(64);

class Client {
  messages: ServerMessage[] = [];
  closed = false;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(String(d))));
    ws.on('close', () => (this.closed = true));
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  of<T extends ServerMessage['t']>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  forSession(id: string): ServerMessage[] {
    return this.messages.filter((m) => (m.t === 'snapshot' || m.t === 'output') && m.id === id);
  }
}

const PAGE = 'a'.repeat(32) + '.localhost';

describe('websocket', () => {
  const home = useTempHome();
  let server: Server;
  let port = 0;
  let mgr: SessionManager;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let handle: { close(): void };
  let usage: UsageStore;
  let activity: ActivityMeter;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ptys = fakePtyFactory();
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    mgr = new SessionManager({ ptyFactory: ptys.factory, now: Date.now, config: defaultConfig, port, hookToken: 'h', hookScriptPath: '/h.js', statusScriptPath: '/s.js', builtins: () => [], gitOf: async () => null, headOf: () => null });
    usage = new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') });
    activity = new ActivityMeter(Date.now);
    mgr.onOutput((id, data) => activity.add(id, data.length));
    handle = attachWebSocket(server, { manager: mgr, usage, activity, port, pageHost: PAGE, token: TOKEN });
  });

  afterEach(async () => {
    for (const s of sockets) s.terminate();
    sockets.length = 0;
    handle.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  function open(headers: Record<string, string>, path = '/ws', protocols: string[] = ['shellyard', `shellyard-token.${TOKEN}`]): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers });
      sockets.push(ws);
      const client = new Client(ws);
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    });
  }
  const good = (): Record<string, string> => ({ host: `${PAGE}:${port}`, origin: `http://${PAGE}:${port}` });
  const connect = (): Promise<Client> => open(good());
  const shell = (): SessionInfo => mgr.create({ kind: 'shell', command: process.execPath, cwd: home.dir() });

  describe('upgrade checks', () => {
    it('accepts the token offered in the subprotocol list and settles on the shellyard protocol', async () => {
      const c = await connect();
      expect(c.ws.protocol).toBe('shellyard');
    });
    it('refuses a connection that offers no token', async () => {
      await expect(open(good(), '/ws', ['shellyard'])).rejects.toThrow(/refused 401/);
      await expect(open(good(), '/ws', [])).rejects.toThrow(/refused 401/);
    });
    it('refuses a wrong token', async () => {
      await expect(open(good(), '/ws', ['shellyard', 'shellyard-token.' + 'b'.repeat(64)])).rejects.toThrow(/refused 401/);
    });
    it('refuses a cookie in place of the token', async () => {
      await expect(open({ ...good(), cookie: `shellyard_auth=${TOKEN}` }, '/ws', ['shellyard'])).rejects.toThrow(/refused 401/);
    });
    it('refuses a foreign origin that offers the protocol name but no token', async () => {
      await expect(open({ origin: 'http://evil.com' }, '/ws', ['shellyard'])).rejects.toThrow(/refused 403/);
    });
    it('refuses a foreign origin even with the token', async () => {
      await expect(open({ origin: 'http://evil.com' })).rejects.toThrow(/refused 403/);
    });
    it('refuses a connection with no origin', async () => {
      await expect(open({})).rejects.toThrow(/refused 403/);
    });
    it('refuses a foreign host header', async () => {
      await expect(open({ ...good(), host: 'evil.com' })).rejects.toThrow(/refused 403/);
    });
    it('refuses the fixed loopback address and its origin: only the page host of this start connects', async () => {
      await expect(open({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).rejects.toThrow(/refused 403/);
      await expect(open({ ...good(), origin: `http://127.0.0.1:${port}` })).rejects.toThrow(/refused 403/);
    });
    it('refuses a tab from an earlier start as unauthorized', async () => {
      const old = `${'b'.repeat(32)}.localhost:${port}`;
      await expect(open({ host: old, origin: `http://${old}` })).rejects.toThrow(/refused 401/);
    });
    it('refuses another path', async () => {
      await expect(open(good(), '/other')).rejects.toThrow(/refused 404/);
    });
  });

  it('sends the session list first', async () => {
    const s = shell();
    const c = await connect();
    await waitUntil(() => c.messages.length > 0);
    expect(c.messages[0]).toEqual({ t: 'sessions', sessions: [mgr.get(s.id)] });
  });

  it('answers attach with a snapshot of earlier output, then streams in order', async () => {
    const s = shell();
    const pty = ptys.last();
    pty.emit('earlier-output');
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 90, rows: 25 });
    await waitUntil(() => c.of('snapshot').length === 1);
    expect(c.forSession(s.id)[0]).toMatchObject({ t: 'snapshot', id: s.id });
    expect(c.of('snapshot')[0]!.data).toContain('earlier-output');
    expect(pty.resizes).toEqual([[90, 25]]);
    pty.emit('one');
    pty.emit('two');
    pty.emit('three');
    await waitUntil(() => c.of('output').length === 3);
    expect(c.of('output').map((m) => m.data)).toEqual(['one', 'two', 'three']);
  });

  it('does not lose or reorder output produced while the snapshot is being taken', async () => {
    const s = shell();
    const pty = ptys.last();
    pty.emit('before;');
    // Hold the snapshot back so that output really arrives while it is being taken.
    const realSnapshot = mgr.snapshot.bind(mgr);
    let asked = false;
    mgr.snapshot = async (id: string) => {
      const taken = realSnapshot(id);
      asked = true;
      await new Promise((r) => setTimeout(r, 150));
      return taken;
    };
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => asked);
    pty.emit('during;');
    expect(c.forSession(s.id)).toEqual([]);
    await waitUntil(() => c.of('output').length === 1);
    const msgs = c.forSession(s.id);
    expect(msgs[0]!.t).toBe('snapshot');
    const all = msgs.map((m) => (m.t === 'snapshot' || m.t === 'output' ? m.data : '')).join('');
    expect(all.indexOf('before;')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('during;')).toBeGreaterThan(all.indexOf('before;'));
    expect(all.split('during;').length - 1).toBe(1);
  });

  it('does not send output for sessions a client has not attached to', async () => {
    const a = shell();
    const pa = ptys.last();
    const b = shell();
    const pb = ptys.last();
    const c = await connect();
    c.send({ t: 'attach', id: a.id, cols: 80, rows: 24 });
    await waitUntil(() => c.of('snapshot').length === 1);
    pb.emit('other');
    pa.emit('mine');
    await waitUntil(() => c.of('output').length === 1);
    expect(c.of('output')).toEqual([{ t: 'output', id: a.id, data: 'mine' }]);
    expect(c.forSession(b.id)).toEqual([]);
  });

  it('serves two clients on one session, and one leaving does not affect the other', async () => {
    const s = shell();
    const pty = ptys.last();
    const c1 = await connect();
    const c2 = await connect();
    for (const c of [c1, c2]) c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => c1.of('snapshot').length === 1 && c2.of('snapshot').length === 1);
    pty.emit('both');
    await waitUntil(() => c1.of('output').length === 1 && c2.of('output').length === 1);
    c1.ws.close();
    await waitUntil(() => c1.closed);
    pty.emit('second-only');
    await waitUntil(() => c2.of('output').length === 2);
    expect(c2.of('output')[1]!.data).toBe('second-only');
    expect(mgr.get(s.id)!.status).toBe('running');
    expect(pty.killed).toBe(false);
  });

  it('stops streaming after detach', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => c.of('snapshot').length === 1);
    c.send({ t: 'detach', id: s.id });
    c.send({ t: 'input', id: s.id, data: 'x' });
    await waitUntil(() => pty.written.length === 1);
    pty.emit('after-detach');
    await new Promise((r) => setTimeout(r, 100));
    expect(c.of('output')).toEqual([]);
  });

  it('a second attach from the same client does not double the output', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => c.of('snapshot').length >= 1);
    pty.emit('once');
    await new Promise((r) => setTimeout(r, 100));
    // The second attach replaces the first: one snapshot, one copy of each later chunk.
    expect(c.of('snapshot')).toHaveLength(1);
    expect(c.of('output').map((m) => m.data)).toEqual(['once']);
  });

  it('passes input and resize to the session, ignoring a degenerate size', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send({ t: 'input', id: s.id, data: 'ls\r' });
    c.send({ t: 'resize', id: s.id, cols: 0, rows: 24 });
    c.send({ t: 'resize', id: s.id, cols: 100, rows: 40 });
    await waitUntil(() => pty.resizes.length === 1 && pty.written.length === 1);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.resizes).toEqual([[100, 40]]);
  });

  it('sends the snapshot with the size it was taken at', async () => {
    const s = shell();
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 90, rows: 25 });
    await waitUntil(() => c.of('snapshot').length === 1);
    expect(c.of('snapshot')[0]).toMatchObject({ cols: 90, rows: 25 });
    // The size came with the snapshot: it is not told a second time.
    expect(c.of('size')).toEqual([]);
  });

  it('tells a new size to the pages showing the session, where it changed in the output', async () => {
    const s = shell();
    const other = shell();
    const pty = ptys.last(); // of `other`
    const first = ptys.ptys[ptys.ptys.length - 2]!;
    const c1 = await connect();
    const c2 = await connect();
    c1.send({ t: 'attach', id: s.id, cols: 90, rows: 25 });
    c2.send({ t: 'attach', id: s.id, cols: 0, rows: 0 });
    await waitUntil(() => c1.of('snapshot').length === 1 && c2.of('snapshot').length === 1);
    expect(c2.of('snapshot')[0]).toMatchObject({ cols: 90, rows: 25 });
    first.emit('before');
    c1.send({ t: 'resize', id: s.id, cols: 120, rows: 40 });
    await waitUntil(() => first.resizes.length === 2);
    first.emit('after');
    // A session neither page shows: its size is no business of theirs.
    c1.send({ t: 'resize', id: other.id, cols: 70, rows: 20 });
    await waitUntil(() => pty.resizes.length === 1);
    // The same size again changes nothing, and says nothing.
    c1.send({ t: 'resize', id: s.id, cols: 120, rows: 40 });
    for (const c of [c1, c2]) {
      await waitUntil(() => c.of('output').length === 2);
      const stream = c.messages.filter((m) => m.t === 'output' || m.t === 'size');
      expect(stream).toEqual([
        { t: 'output', id: s.id, data: 'before' },
        { t: 'size', id: s.id, cols: 120, rows: 40 },
        { t: 'output', id: s.id, data: 'after' },
      ]);
    }
  });

  it('holds a new size back, in its place among the output, while the snapshot is being taken', async () => {
    const s = shell();
    const pty = ptys.last();
    const c1 = await connect();
    const c2 = await connect();
    c1.send({ t: 'attach', id: s.id, cols: 90, rows: 25 });
    await waitUntil(() => c1.of('snapshot').length === 1);
    const realSnapshot = mgr.snapshot.bind(mgr);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let taking = false;
    mgr.snapshot = async (id: string) => {
      const data = await realSnapshot(id);
      taking = true;
      await held;
      return data;
    };
    c2.send({ t: 'attach', id: s.id, cols: 0, rows: 0 });
    await waitUntil(() => taking);
    pty.emit('one');
    c1.send({ t: 'resize', id: s.id, cols: 120, rows: 40 });
    await waitUntil(() => pty.resizes.length === 2);
    pty.emit('two');
    await waitUntil(() => c1.of('output').length === 2);
    release();
    await waitUntil(() => c2.of('output').length === 2);
    // The snapshot was taken before the resize: it says the size it was taken at, not the one of now.
    expect(c2.messages.filter((m) => m.t === 'snapshot' || m.t === 'output' || m.t === 'size').map((m) => (m.t === 'output' ? m.data : m.t === 'size' ? `${m.cols}x${m.rows}` : `snapshot ${m.cols}x${m.rows}`))).toEqual([
      'snapshot 90x25',
      'one',
      '120x40',
      'two',
    ]);
  });

  it('survives garbage, unknown message types, wrong field types and unknown sessions', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send('not json');
    c.send({ t: 'explode' });
    c.send({ t: 'attach', id: 'nope', cols: 80, rows: 24 });
    c.send({ t: 'input', id: s.id, data: 42 });
    c.send({ t: 'input', id: 'nope', data: 'x' });
    c.send({ t: 'resize', id: s.id, cols: 'wide', rows: null });
    c.send('null');
    c.send({ t: 'input', id: s.id, data: 'still-alive' });
    await waitUntil(() => pty.written.length === 1);
    expect(pty.written).toEqual(['still-alive']);
    expect(c.closed).toBe(false);
    expect(pty.resizes).toEqual([]);
  });

  it('sends the usage summary on connect and again after it changes', async () => {
    const c = await connect();
    await waitUntil(() => c.of('usage').length === 1);
    expect(c.of('usage')[0]!.usage.today.costUsd).toBe(0);
    usage.record('s1', { modelId: 'm', modelName: 'M', costUsd: 2, tokensIn: 1, tokensOut: 1, fiveHour: null, sevenDay: null }, { storyId: null, storyName: null });
    await waitUntil(() => c.of('usage').length === 2, 4000);
    expect(c.of('usage')[1]!.usage.today.costUsd).toBeCloseTo(2);
  });

  it('reports how much sessions are printing, then that they went quiet', async () => {
    const s = shell();
    const c = await connect();
    ptys.last().emit('x'.repeat(500));
    await waitUntil(() => c.of('activity').length >= 1, 4000);
    expect(c.of('activity')[0]!.rates[s.id]).toBe(500);
    await waitUntil(() => c.of('activity').some((m) => Object.keys(m.rates).length === 0), 5000);
    const after = c.of('activity').length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.of('activity').length).toBe(after);
  });

  it('broadcasts status changes to every client', async () => {
    const s = mgr.create({ kind: 'claude', command: process.execPath, cwd: home.dir() });
    const c1 = await connect();
    const c2 = await connect();
    await waitUntil(() => c1.of('sessions').length === 1 && c2.of('sessions').length === 1);
    mgr.hook(s.id, 'UserPromptSubmit', false);
    await waitUntil(() => c1.of('sessions').length === 2 && c2.of('sessions').length === 2);
    expect(c1.of('sessions')[1]!.sessions[0]!.status).toBe('working');
    expect(c2.of('sessions')[1]!.sessions[0]!.status).toBe('working');
  });
});
