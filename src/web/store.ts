import { useSyncExternalStore } from 'react';
import type { AreaRule, ChangeSummary, ClosedSession, ErrorReport, LanStatus, Meta, Schedule, SessionInfo, SoundFile, SoundLibrary, Story, UsageSummary } from '../shared/types.js';
import { api, configureApi } from './api.js';
import { loadEffects, loadSound, saveEffects, saveSound, type EffectsLevel } from './effects.js';
import { connect, type ConnectionState, type Socket } from './socket.js';
import { emptyHistory, recordActivity, type SparkHistory } from './sparkline.js';
import { pruneSelection, toggleSelected } from './selection.js';
import { addToDigest, loadFocus, saveFocus, startFocus, type Focus } from './focus.js';
import { loadThemeChoice, resolveTheme, saveThemeChoice, systemPrefersLight, watchSystemTheme, type Theme, type ThemeChoice } from './theme.js';
import { loadToken, rememberToken, wsProtocols } from './token.js';

/** `storyFilter`: a story id, null for the ungrouped sessions, undefined for everything. */
export type View =
  | { kind: 'board' }
  | { kind: 'attention'; storyFilter?: string | null }
  | { kind: 'grid'; storyFilter?: string | null }
  | { kind: 'usage' }
  | { kind: 'conversations' }
  | { kind: 'schedules' }
  | { kind: 'single'; id: string };

interface State {
  sessions: SessionInfo[];
  stories: Story[];
  /** The area rules: commands the sessions of an area run without asking. */
  rules: AreaRule[];
  /** Sessions that ended or were closed, newest first. */
  closed: ClosedSession[];
  schedules: Schedule[];
  /** Null until the server has sent it. */
  usage: UsageSummary | null;
  /** Bytes printed in the last second per session; absent means quiet. */
  activity: Record<string, number>;
  /** The unexpected errors of this run of the server, newest first. */
  errors: ErrorReport[];
  /** The uncommitted changes of the worktrees sessions work in, by worktree path. */
  changes: Record<string, ChangeSummary>;
  /** Phone access: on or off, where, how many connected. Null until the server has sent it. */
  lan: LanStatus | null;
  /** What each terminal printed over the last minutes, for the lines on the board. */
  sparks: SparkHistory;
  /** Sessions picked on the board for one action on all of them, in the order picked. */
  selection: string[];
  /** Focus: only blocked sessions interrupt until it ends; null when off. */
  focus: Focus | null;
  /** Sessions that finished during the focus, for the digest at its end. */
  digest: string[];
  /** The names in the digest just shown, until it is dismissed. */
  digestShown: string[] | null;
  /** False until the first list arrives, so an empty list is not shown as "nothing open". */
  loaded: boolean;
  view: View;
  connection: ConnectionState;
  meta: Meta;
  soundLibrary: SoundLibrary;
  /** How much the interface moves; a choice of this browser. */
  effects: EffectsLevel;
  sound: boolean;
  /** What the user chose, and the theme that choice comes to right now. */
  themeChoice: ThemeChoice;
  theme: Theme;
}

let state: State = {
  sessions: [],
  stories: [],
  rules: [],
  closed: [],
  schedules: [],
  usage: null,
  activity: {},
  errors: [],
  changes: {},
  lan: null,
  sparks: emptyHistory(),
  selection: [],
  focus: null,
  digest: [],
  digestShown: null,
  loaded: false,
  view: { kind: 'board' },
  connection: 'connecting',
  meta: { profiles: [], models: [], saved: [] },
  soundLibrary: { sounds: [], settings: { blocked: null, finished: null, maybeWaiting: null } },
  effects: 'reduced',
  sound: true,
  themeChoice: 'system',
  theme: 'dark',
};
const listeners = new Set<() => void>();
const sessionListeners: Array<(prev: SessionInfo[], next: SessionInfo[]) => void> = [];
const errorListeners: Array<(prev: ErrorReport[], next: ErrorReport[]) => void> = [];
const scheduleListeners: Array<(prev: Schedule[], next: Schedule[]) => void> = [];
let socket: Socket | null = null;
/** A token taken from the address, to be stored once the server has accepted it. */
let unconfirmedToken: string | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

export function getState(): State {
  return state;
}

export function getSocket(): Socket {
  if (!socket) throw new Error('The store has not been started');
  return socket;
}

function applyEffects(level: EffectsLevel): void {
  // The stylesheet switches animations on this attribute.
  if (typeof document !== 'undefined') document.documentElement.dataset.effects = level;
}

const themeListeners = new Set<(theme: Theme) => void>();

/** For what is drawn outside the stylesheet's reach (the terminals). Returns an unsubscribe. */
export function onThemeChange(cb: (theme: Theme) => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

function applyTheme(choice: ThemeChoice): void {
  const theme = resolveTheme(choice, systemPrefersLight());
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  const changed = theme !== state.theme;
  set({ themeChoice: choice, theme });
  if (changed) for (const cb of [...themeListeners]) cb(theme);
}

export function setTheme(choice: ThemeChoice): void {
  saveThemeChoice(choice);
  applyTheme(choice);
}

export function setEffects(effects: EffectsLevel): void {
  saveEffects(effects);
  applyEffects(effects);
  set({ effects });
}

export function setSound(sound: boolean): void {
  saveSound(sound);
  set({ sound });
}

/**
 * Shows a reorder or a move at once, before the server confirms it; the server's next
 * update (or `refreshMeta()` for launchers) replaces it with the truth.
 */
export function applyLocally(patch: { sessions?: SessionInfo[]; stories?: Story[]; profiles?: Meta['profiles'] }): void {
  const { profiles, ...rest } = patch;
  set(profiles ? { ...rest, meta: { ...state.meta, profiles } } : rest);
}

export function setView(view: View): void {
  set({ view });
}

/** Picks a session on the board, or puts it back. */
export function toggleSelection(id: string): void {
  set({ selection: toggleSelected(state.selection, id) });
}

export function startFocusNow(): void {
  const focus = startFocus(Date.now());
  saveFocus(focus);
  set({ focus, digest: [], digestShown: null });
}

/** Ends the focus (by itself or by the user) and shows what finished meanwhile. Returns the names. */
export function endFocus(): string[] {
  const names = state.digest.map((id) => state.sessions.find((s) => s.id === id)?.name).filter((n): n is string => !!n);
  saveFocus(null);
  set({ focus: null, digest: [], digestShown: names });
  return names;
}

export function noteDigest(ids: string[]): void {
  if (ids.length > 0) set({ digest: addToDigest(state.digest, ids) });
}

export function dismissDigest(): void {
  set({ digestShown: null });
}

export function clearSelection(): void {
  if (state.selection.length > 0) set({ selection: [] });
}

export async function refreshMeta(): Promise<void> {
  try {
    const meta = await api.meta();
    if (unconfirmedToken) {
      rememberToken(unconfirmedToken);
      unconfirmedToken = null;
    }
    set({ meta });
  } catch {
    // The profile list is not essential; it is retried the next time the dialog opens.
  }
}

/**
 * Cut saves, numbered in the order they were sent. A library read that overlaps one is dropped,
 * as it may hold a cut older than the one the save answers with, and made again once no save is
 * on its way.
 */
let trimsSent = 0;
let trimsInFlight = 0;
let readDropped = false;
const lastTrimSent = new Map<string, number>();

export async function refreshSounds(): Promise<void> {
  // Kept only when no save was on its way while it was read: none when it started, none sent since.
  const quietBefore = trimsInFlight === 0;
  const sentBefore = trimsSent;
  try {
    const library = await api.sounds();
    if (quietBefore && trimsSent === sentBefore) set({ soundLibrary: library });
    else if (trimsInFlight > 0) readDropped = true; // read again once the saves have answered
    else return await refreshSounds(); // the saves it overlapped have all answered: read again now
  } catch {
    // The library is not essential; it is read again after the next change.
  }
}

/**
 * Saves the cut of a sound and puts the sound as the server now has it into the library, unless a
 * later save of the same sound was sent meanwhile (its answer is the one that counts).
 */
export async function saveSoundTrim(id: string, trim: { start: number; end: number | null }): Promise<SoundFile> {
  const n = ++trimsSent;
  lastTrimSent.set(id, n);
  trimsInFlight++;
  try {
    const file = await api.trimSound(id, trim);
    if (lastTrimSent.get(id) === n) {
      const { sounds, settings } = state.soundLibrary;
      set({ soundLibrary: { settings, sounds: sounds.map((s) => (s.id === file.id ? file : s)) } });
    }
    return file;
  } catch (err) {
    // The newest save failed, but an earlier one may have been stored: read what the server keeps.
    if (lastTrimSent.get(id) === n) readDropped = true;
    throw err;
  } finally {
    if (lastTrimSent.get(id) === n) lastTrimSent.delete(id);
    trimsInFlight--;
    if (trimsInFlight === 0 && readDropped) {
      readDropped = false;
      void refreshSounds();
    }
  }
}

/** Called with the schedules before and after each update from the server, after the first. */
export function onSchedulesChange(cb: (prev: Schedule[], next: Schedule[]) => void): void {
  scheduleListeners.push(cb);
}

/** Runs on every change of the session list, with the list before and after. */
export function onSessionsChange(cb: (prev: SessionInfo[], next: SessionInfo[]) => void): void {
  sessionListeners.push(cb);
}

/** Runs on every change of the error list, with the list before and after. */
export function onErrorsChange(cb: (prev: ErrorReport[], next: ErrorReport[]) => void): void {
  errorListeners.push(cb);
}

/** A view filtered on a story that has been deleted falls back to showing everything. */
function withoutDeadFilter(view: View, stories: Story[]): View {
  if (view.kind !== 'attention' && view.kind !== 'grid') return view;
  if (typeof view.storyFilter !== 'string') return view;
  return stories.some((s) => s.id === view.storyFilter) ? view : { kind: view.kind };
}

export function startStore(): void {
  if (socket) return;
  const effects = loadEffects();
  applyEffects(effects);
  set({ effects, sound: loadSound(), focus: loadFocus(Date.now()) });
  applyTheme(loadThemeChoice());
  watchSystemTheme(() => {
    if (state.themeChoice === 'system') applyTheme('system');
  });
  const loaded = loadToken();
  if (!loaded) {
    // Opened by typing the address, or in a browser that never received the token.
    set({ connection: 'unauthorized' });
    return;
  }
  const { token } = loaded;
  if (loaded.fromAddress) unconfirmedToken = token;
  // A token left over from an earlier run of the server is refused: say how to get back in,
  // and stop knocking on a server that will never let this token in.
  configureApi({
    token,
    onUnauthorized: () => {
      set({ connection: 'unauthorized' });
      socket?.stop();
    },
  });
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = connect(`${scheme}://${location.host}/ws`, wsProtocols(token));
  socket.onSessions((sessions) => {
    const prev = state.sessions;
    const wasLoaded = state.loaded;
    // A session shown on its own that no longer exists sends the user back to the grid.
    const current = state.view;
    const view: View = current.kind === 'single' && !sessions.some((s) => s.id === current.id) ? { kind: 'grid' } : current;
    set({ sessions, loaded: true, view, selection: pruneSelection(state.selection, new Set(sessions.map((s) => s.id))) });
    if (wasLoaded) for (const cb of sessionListeners) cb(prev, sessions);
  });
  socket.onStories((stories) => set({ stories, view: withoutDeadFilter(state.view, stories) }));
  socket.onRules((rules) => set({ rules }));
  socket.onClosed((closed) => set({ closed }));
  let schedulesLoaded = false;
  socket.onSchedules((schedules) => {
    const prev = state.schedules;
    set({ schedules });
    if (schedulesLoaded) for (const cb of scheduleListeners) cb(prev, schedules);
    schedulesLoaded = true;
  });
  socket.onUsage((usage) => set({ usage }));
  socket.onErrors((errors) => {
    const prev = state.errors;
    set({ errors });
    for (const cb of errorListeners) cb(prev, errors);
  });
  socket.onChanges((list) => set({ changes: Object.fromEntries(list.map((c) => [c.worktree, c])) }));
  socket.onLan((lan) => set({ lan }));
  socket.onActivity((activity) => set({ activity, sparks: recordActivity(state.sparks, activity, Date.now()) }));
  socket.onState((connection) => {
    // Once the token is known to be refused, a failing socket must not hide that message.
    if (state.connection === 'unauthorized') return;
    set({ connection });
    if (connection === 'open') {
      void refreshMeta();
      void refreshSounds();
    }
  });
  // A handshake refused for a stale token looks like a server that is not running. An API
  // call tells them apart (401 → onUnauthorized above), so ask after every failed attempt:
  // a tab left open across a server restart must end up being told what to do.
  socket.onAttemptFailed(() => {
    if (state.connection !== 'unauthorized') void refreshMeta();
  });
  void refreshMeta();
  void refreshSounds();
}

export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
