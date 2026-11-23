import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, LanStatus, ServerMessage } from '../shared/types.js';
import { localGate, safeEqual, tokenFromProtocols, WS_PROTOCOL, type Gate } from './auth.js';
import type { SessionManager } from './session-manager.js';
import type { ActivityMeter } from './activity.js';
import type { RuleStore } from './area-rules.js';
import type { ClosedStore } from './closed.js';
import type { ScheduleStore } from './schedules.js';
import type { StoryStore } from './stories.js';
import type { UsageStore } from './usage.js';
import type { ErrorReporter } from './errors.js';
import type { ChangeTracker } from './changes.js';

interface Subscription {
  /** False while the snapshot is being taken; what happens meanwhile is held back until it is sent. */
  ready: boolean;
  buffer: ServerMessage[];
}

interface Client {
  ws: WebSocket;
  subs: Map<string, Subscription>;
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  switch (o.t) {
    case 'attach':
    case 'resize':
      if (typeof o.cols !== 'number' || typeof o.rows !== 'number') return null;
      return { t: o.t, id: o.id, cols: o.cols, rows: o.rows };
    case 'detach':
      return { t: 'detach', id: o.id };
    case 'input':
      if (typeof o.data !== 'string') return null;
      return { t: 'input', id: o.id, data: o.data };
    default:
      return null;
  }
}

export interface WebSocketDeps {
  manager: SessionManager;
  stories?: StoryStore;
  rules?: RuleStore;
  closed?: ClosedStore;
  schedules?: ScheduleStore;
  usage?: UsageStore;
  activity?: ActivityMeter;
  errors?: ErrorReporter;
  changes?: ChangeTracker;
  /** The status of phone access, sent to every page so the header can say it is on. */
  lan?: { status(): LanStatus; onChange(cb: (s: LanStatus) => void): void };
  port: number;
  pageHost: string;
  token: string;
  /** What this listener lets in; absent, the loopback listener's own (see http.ts). */
  gate?: Gate;
  /** A page connected or left. */
  onClients?: () => void;
}

export interface WebSocketHandle {
  close(): void;
  clientCount(): number;
  /** Closes every connected page, keeping the WebSocket server ready for new ones. */
  disconnectAll(): void;
}

export function attachWebSocket(server: Server, deps: WebSocketDeps): WebSocketHandle {
  const { manager } = deps;
  const gate = deps.gate ?? localGate(deps.port, deps.pageHost, deps.token);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    // Answer with the protocol name only; the token entry is never echoed back.
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  const clients = new Set<Client>();

  const send = (c: Client, m: ServerMessage): void => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  };

  manager.onChange((sessions) => {
    for (const c of clients) send(c, { t: 'sessions', sessions });
  });

  deps.stories?.onChange((stories) => {
    for (const c of clients) send(c, { t: 'stories', stories });
  });

  deps.rules?.onChange((rules) => {
    for (const c of clients) send(c, { t: 'rules', rules });
  });

  deps.closed?.onChange((closed) => {
    for (const c of clients) send(c, { t: 'closed', closed });
  });

  deps.schedules?.onChange((schedules) => {
    for (const c of clients) send(c, { t: 'schedules', schedules });
  });

  deps.errors?.onChange((errors) => {
    for (const c of clients) send(c, { t: 'errors', errors });
  });
  deps.changes?.onChange((changes) => {
    for (const c of clients) send(c, { t: 'changes', changes });
  });
  deps.lan?.onChange((lan) => {
    for (const c of clients) send(c, { t: 'lan', lan });
  });

  // Usage changes with every status report; clients get at most one update per pulse.
  let usageDirty = false;
  deps.usage?.onChange(() => (usageDirty = true));
  let usageDay = deps.usage?.today();
  // Activity is sent on each pulse while anything is printing, then once more, empty, so
  // that the rev counters fall back to rest.
  let wasActive = false;
  const pulse = setInterval(() => {
    // Read even with nobody connected: reading is what clears sessions that went quiet.
    const rates = deps.activity?.rates();
    if (clients.size === 0) {
      wasActive = false;
      return;
    }
    if (deps.usage) {
      // "Today" changes at midnight even if no session reports anything.
      const day = deps.usage.today();
      if (day !== usageDay) {
        usageDay = day;
        usageDirty = true;
      }
      if (usageDirty) {
        usageDirty = false;
        const usage = deps.usage.summary();
        for (const c of clients) send(c, { t: 'usage', usage });
      }
    }
    if (rates) {
      const active = Object.keys(rates).length > 0;
      if (active || wasActive) for (const c of clients) send(c, { t: 'activity', rates });
      wasActive = active;
    }
    // Twice per measuring window (activity counts the last second), so that a burst landing
    // just after one tick is still inside the window at the next.
  }, 500);
  pulse.unref?.();

  manager.onOutput((id, data) => {
    for (const c of clients) {
      const sub = c.subs.get(id);
      if (!sub) continue;
      const m: ServerMessage = { t: 'output', id, data };
      if (sub.ready) send(c, m);
      else sub.buffer.push(m);
    }
  });

  /**
   * Resizes a session and tells the pages showing it, in the stream of its output: what the
   * program prints from here on is drawn for the new size, so a terminal has to take the size
   * at this very point. Taking it later (from the session list) leaves its screen out of place.
   */
  function resize(id: string, cols: number, rows: number): void {
    const before = manager.get(id);
    if (!before) return;
    manager.resize(id, cols, rows);
    const after = manager.get(id);
    if (!after || (after.cols === before.cols && after.rows === before.rows)) return;
    const m: ServerMessage = { t: 'size', id, cols: after.cols, rows: after.rows };
    for (const c of clients) {
      const sub = c.subs.get(id);
      if (!sub) continue;
      if (sub.ready) send(c, m);
      else sub.buffer.push(m);
    }
  }

  function attach(c: Client, id: string, cols: number, rows: number): void {
    if (!manager.get(id)) return;
    resize(id, cols, rows);
    // Buffering starts in the same tick as the snapshot request, so the two meet exactly:
    // the snapshot holds everything before this point, the buffer everything after.
    const sub: Subscription = { ready: false, buffer: [] };
    c.subs.set(id, sub);
    void manager.snapshot(id).then((snapshot) => {
      // A newer attach or a detach has replaced this subscription: drop the stale answer.
      if (c.subs.get(id) !== sub || snapshot === null) return;
      // With the size the screen had as it was serialized, which the terminal has to have to
      // draw it; a resize since then is in the buffer, after it.
      send(c, { t: 'snapshot', id, ...snapshot });
      for (const m of sub.buffer) send(c, m);
      sub.buffer = [];
      sub.ready = true;
    });
  }

  function onMessage(c: Client, raw: string): void {
    const m = parseMessage(raw);
    if (!m) return;
    switch (m.t) {
      case 'attach':
        attach(c, m.id, m.cols, m.rows);
        break;
      case 'detach':
        c.subs.delete(m.id);
        break;
      case 'input':
        manager.input(m.id, m.data);
        break;
      case 'resize':
        resize(m.id, m.cols, m.rows);
        break;
    }
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return refuse(socket, 404, 'Not Found');
    // Only the page of this start connects; a tab from an earlier start is refused as unauthorized.
    const hostKind = gate.classify(req);
    if (hostKind === 'stale-page') return refuse(socket, 401, 'Unauthorized');
    if (hostKind !== 'page') return refuse(socket, 403, 'Forbidden');
    // A page on any site can open a WebSocket to localhost; the Origin check is what stops it.
    if (!gate.originAllowed(req.headers.origin, req)) return refuse(socket, 403, 'Forbidden');
    // A browser cannot add headers to a WebSocket handshake, so the page offers the token as
    // a subprotocol. Unlike a cookie, it is sent only because the page chose to send it.
    // Read at each handshake: once the phone link changes, the old one opens nothing.
    const offered = tokenFromProtocols(req.headers['sec-websocket-protocol']);
    if (!offered || !safeEqual(offered, gate.token())) return refuse(socket, 401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, subs: new Map() };
      clients.add(client);
      deps.onClients?.();
      send(client, { t: 'sessions', sessions: manager.list() });
      if (deps.stories) send(client, { t: 'stories', stories: deps.stories.list() });
      if (deps.rules) send(client, { t: 'rules', rules: deps.rules.list() });
      if (deps.closed) send(client, { t: 'closed', closed: deps.closed.list() });
      if (deps.schedules) send(client, { t: 'schedules', schedules: deps.schedules.list() });
      if (deps.usage) send(client, { t: 'usage', usage: deps.usage.summary() });
      if (deps.errors) send(client, { t: 'errors', errors: deps.errors.list() });
      if (deps.changes) send(client, { t: 'changes', changes: deps.changes.list() });
      if (deps.lan) send(client, { t: 'lan', lan: deps.lan.status() });
      ws.on('message', (data, isBinary) => {
        if (!isBinary) onMessage(client, String(data));
      });
      const leave = (): void => {
        if (clients.delete(client)) deps.onClients?.();
      };
      ws.on('close', leave);
      ws.on('error', leave);
    });
  };

  server.on('upgrade', onUpgrade);

  const disconnectAll = (): void => {
    const had = clients.size > 0;
    for (const c of clients) c.ws.terminate();
    clients.clear();
    if (had) deps.onClients?.();
  };

  return {
    close(): void {
      server.off('upgrade', onUpgrade);
      clearInterval(pulse);
      for (const c of clients) c.ws.terminate();
      clients.clear();
      wss.close();
    },
    clientCount: () => clients.size,
    disconnectAll,
  };
}
