import type { AreaRule, ChangeSummary, ClientMessage, ClosedSession, ErrorReport, LanStatus, Schedule, ServerMessage, SessionInfo, Story, UsageSummary } from '../shared/types.js';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'down' | 'unauthorized';
export type TerminalMessage = { t: 'snapshot' | 'output'; data: string };

export interface Socket {
  send(m: ClientMessage): void;
  /** Receives the snapshot and the live output of one session. Returns an unsubscribe. */
  subscribe(id: string, cb: (m: TerminalMessage) => void): () => void;
  onSessions(cb: (s: SessionInfo[]) => void): void;
  onStories(cb: (s: Story[]) => void): void;
  onRules(cb: (r: AreaRule[]) => void): void;
  onClosed(cb: (c: ClosedSession[]) => void): void;
  onSchedules(cb: (s: Schedule[]) => void): void;
  onUsage(cb: (u: UsageSummary) => void): void;
  onActivity(cb: (rates: Record<string, number>) => void): void;
  onErrors(cb: (e: ErrorReport[]) => void): void;
  onChanges(cb: (c: ChangeSummary[]) => void): void;
  onLan(cb: (l: LanStatus) => void): void;
  /** Called on every state change. Returns an unsubscribe. */
  onState(cb: (s: ConnectionState) => void): () => void;
  /** Called every time a connection attempt fails or a connection is lost. */
  onAttemptFailed(cb: () => void): void;
  /** Stops reconnecting for good. */
  stop(): void;
  state(): ConnectionState;
}

const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const FAILURES_BEFORE_DOWN = 5;

/** A WebSocket that reconnects by itself and tells its listeners what state it is in. */
export function connect(url: string, protocols: string[]): Socket {
  let ws: WebSocket | null = null;
  let state: ConnectionState = 'connecting';
  let failures = 0;
  let delay = FIRST_DELAY_MS;
  const terminalSubs = new Map<string, Set<(m: TerminalMessage) => void>>();
  const sessionCbs: Array<(s: SessionInfo[]) => void> = [];
  const storyCbs: Array<(s: Story[]) => void> = [];
  const ruleCbs: Array<(r: AreaRule[]) => void> = [];
  const closedCbs: Array<(c: ClosedSession[]) => void> = [];
  const scheduleCbs: Array<(s: Schedule[]) => void> = [];
  const usageCbs: Array<(u: UsageSummary) => void> = [];
  const activityCbs: Array<(rates: Record<string, number>) => void> = [];
  const errorCbs: Array<(e: ErrorReport[]) => void> = [];
  const changesCbs: Array<(c: ChangeSummary[]) => void> = [];
  const lanCbs: Array<(l: LanStatus) => void> = [];
  const stateCbs = new Set<(s: ConnectionState) => void>();
  const failedCbs: Array<() => void> = [];
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const setState = (s: ConnectionState): void => {
    if (s === state) return;
    state = s;
    for (const cb of [...stateCbs]) cb(s);
  };

  const open = (): void => {
    if (stopped) return;
    const socket = new WebSocket(url, protocols);
    ws = socket;
    socket.onopen = () => {
      failures = 0;
      delay = FIRST_DELAY_MS;
      setState('open');
    };
    socket.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (m.t === 'sessions') {
        for (const cb of sessionCbs) cb(m.sessions);
      } else if (m.t === 'stories') {
        for (const cb of storyCbs) cb(m.stories);
      } else if (m.t === 'rules') {
        for (const cb of ruleCbs) cb(m.rules);
      } else if (m.t === 'closed') {
        for (const cb of closedCbs) cb(m.closed);
      } else if (m.t === 'schedules') {
        for (const cb of scheduleCbs) cb(m.schedules);
      } else if (m.t === 'usage') {
        for (const cb of usageCbs) cb(m.usage);
      } else if (m.t === 'activity') {
        for (const cb of activityCbs) cb(m.rates);
      } else if (m.t === 'errors') {
        for (const cb of errorCbs) cb(m.errors);
      } else if (m.t === 'changes') {
        for (const cb of changesCbs) cb(m.changes);
      } else if (m.t === 'lan') {
        for (const cb of lanCbs) cb(m.lan);
      } else {
        const subs = terminalSubs.get(m.id);
        if (subs) for (const cb of [...subs]) cb({ t: m.t, data: m.data });
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      failures++;
      setState(failures >= FAILURES_BEFORE_DOWN ? 'down' : 'reconnecting');
      // A refused handshake looks the same as a server that is not there. The listeners can
      // find out which it is (and may call stop()), so tell them on every failure, not only
      // when the state changes.
      for (const cb of failedCbs) cb();
      if (stopped) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    };
  };
  open();

  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    subscribe(id, cb) {
      let set = terminalSubs.get(id);
      if (!set) terminalSubs.set(id, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) terminalSubs.delete(id);
      };
    },
    onSessions(cb) {
      sessionCbs.push(cb);
    },
    onStories(cb) {
      storyCbs.push(cb);
    },
    onRules(cb) {
      ruleCbs.push(cb);
    },
    onSchedules(cb) {
      scheduleCbs.push(cb);
    },
    onClosed(cb) {
      closedCbs.push(cb);
    },
    onUsage(cb) {
      usageCbs.push(cb);
    },
    onActivity(cb) {
      activityCbs.push(cb);
    },
    onErrors(cb) {
      errorCbs.push(cb);
    },
    onChanges(cb) {
      changesCbs.push(cb);
    },
    onLan(cb) {
      lanCbs.push(cb);
    },
    onState(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onAttemptFailed(cb) {
      failedCbs.push(cb);
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      const current = ws;
      ws = null;
      current?.close();
    },
    state: () => state,
  };
}
