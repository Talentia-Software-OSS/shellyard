import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Profile, SoundFile, SoundSettings, Story } from '../shared/types.js';
import { parseTrim, type Trim } from '../shared/trim.js';
import { normalizeBackground } from './backgrounds.js';
import { normalizeFont } from './fonts.js';

export interface Config {
  profiles: Profile[];
  models: string[];
  silenceMs: number;
  stories: Story[];
  /** Whether the sessions open at the last stop are started again at the next start. */
  restoreSessions: boolean;
  /** Ids of launchers in the order the user wants them; launchers not listed follow. */
  profileOrder: string[];
  /** Labels of the uploaded sounds (the files are in the sounds folder). */
  soundFiles: SoundFile[];
  /** The sound chosen for each event. */
  sounds: SoundSettings;
  /** Phone access: whether the page is also served on the local network, and on which port. */
  lan: LanConfig;
}

export interface LanConfig {
  enabled: boolean;
  /** The port tried first; the next free one is taken if it is busy. */
  port: number;
}

export const DEFAULT_LAN_PORT = 7718;

export function normalizeLan(v: unknown): LanConfig {
  const o = isRecord(v) ? v : {};
  const port = typeof o.port === 'number' && Number.isInteger(o.port) && o.port >= 1024 && o.port <= 65535 ? o.port : DEFAULT_LAN_PORT;
  // Only an explicit true turns it on: anything else leaves the computer reachable from itself alone.
  return { enabled: o.enabled === true, port };
}

export interface ServerState {
  pid: number;
  port: number;
  /** The host name of the page (<32 hex>.localhost); absent in states of servers up to 0.1.2. */
  pageHost?: string;
  token: string;
  hookToken: string;
  startedAt: number;
}

const DEFAULT_MODELS = ['opus', 'sonnet', 'haiku'];
const DEFAULT_SILENCE_MS = 5000;

export const SOUND_ID = /^[0-9a-f-]{36}\.(mp3|wav|ogg)$/;

export function noSounds(): SoundSettings {
  return { blocked: null, finished: null, maybeWaiting: null };
}

/** A stored cut: a valid start is kept even when the end is not; a bad end means the end of the file. */
function storedTrim(start: unknown, end: unknown): Trim {
  const from = parseTrim(start ?? 0, null) ?? { start: 0, end: null };
  return parseTrim(from.start, end) ?? from;
}

export function normalizeSoundFiles(v: unknown): SoundFile[] {
  if (!Array.isArray(v)) return [];
  const out: SoundFile[] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item.id !== 'string' || !SOUND_ID.test(item.id)) continue;
    if (out.some((s) => s.id === item.id)) continue;
    const trim = storedTrim(item.start, item.end);
    out.push({ id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : 'sound', ...trim });
  }
  return out;
}

/** Settings as they may be stored: only ids of known sounds, anything else is the chime. */
export function normalizeSoundSettings(v: unknown, files: SoundFile[]): SoundSettings {
  const o = isRecord(v) ? v : {};
  const pick = (x: unknown): string | null => (typeof x === 'string' && files.some((f) => f.id === x) ? x : null);
  return { blocked: pick(o.blocked), finished: pick(o.finished), maybeWaiting: pick(o.maybeWaiting) };
}

export function defaultConfig(): Config {
  return { profiles: [], models: [...DEFAULT_MODELS], silenceMs: DEFAULT_SILENCE_MS, stories: [], restoreSessions: true, profileOrder: [], soundFiles: [], sounds: noSounds(), lan: normalizeLan(undefined) };
}

/** SHELLYARD_HOME overrides the location, which is how tests avoid the real folder. */
export function dataDir(): string {
  const dir = process.env.SHELLYARD_HOME || join(homedir(), '.shellyard');
  // Private to the user where the file system has modes (Windows relies on the profile folder's ACL).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function runDir(): string {
  const dir = join(dataDir(), 'run');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logPath(): string {
  return join(dataDir(), 'shellyard.log');
}

function configPath(): string {
  return join(dataDir(), 'config.json');
}

function serverStatePath(): string {
  return join(dataDir(), 'server.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function toProfile(v: unknown): Profile | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.command !== 'string') return null;
  const env: Record<string, string> = {};
  if (isRecord(v.env)) {
    for (const [k, val] of Object.entries(v.env)) if (typeof val === 'string') env[k] = val;
  }
  return {
    id: v.id,
    name: v.name,
    kind: v.kind === 'claude' ? 'claude' : 'shell',
    command: v.command,
    args: isStringArray(v.args) ? v.args : [],
    cwd: typeof v.cwd === 'string' ? v.cwd : '',
    color: typeof v.color === 'string' ? v.color : '#888888',
    env,
    model: typeof v.model === 'string' && v.model ? v.model : null,
    background: normalizeBackground(v.background),
    font: normalizeFont(v.font),
  };
}

export function normalizeProfiles(v: unknown): Profile[] {
  if (!Array.isArray(v)) return [];
  return v.map(toProfile).filter((p): p is Profile => p !== null);
}

export function normalizeStories(v: unknown, soundFiles: SoundFile[] = []): Story[] {
  if (!Array.isArray(v)) return [];
  const out: Story[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== 'string' || !item.id) continue;
    // Ids identify stories everywhere; of two hand-written entries with the same id, keep the first.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim()) continue;
    out.push({
      id: item.id,
      name: item.name.trim(),
      ticket: typeof item.ticket === 'string' ? item.ticket : '',
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      color: typeof item.color === 'string' ? item.color : '',
      sound: typeof item.sound === 'string' && soundFiles.some((f) => f.id === item.sound) ? item.sound : '',
    });
  }
  return out;
}

function normalizeConfig(raw: unknown): Config {
  const d = defaultConfig();
  if (!isRecord(raw)) return d;
  const soundFiles = normalizeSoundFiles(raw.soundFiles);
  return {
    profiles: normalizeProfiles(raw.profiles),
    soundFiles,
    sounds: normalizeSoundSettings(raw.sounds, soundFiles),
    stories: normalizeStories(raw.stories, soundFiles),
    restoreSessions: raw.restoreSessions !== false,
    profileOrder: Array.isArray(raw.profileOrder) ? raw.profileOrder.filter((x): x is string => typeof x === 'string') : [],
    models: isStringArray(raw.models) ? raw.models : d.models,
    silenceMs:
      typeof raw.silenceMs === 'number' && Number.isFinite(raw.silenceMs) && raw.silenceMs >= 1000
        ? raw.silenceMs
        : d.silenceMs,
    lan: normalizeLan(raw.lan),
  };
}

const lastGood = new Map<string, Config>();

/** Raised when a change would be written over a config.json that cannot be read as it is. */
export class ConfigInvalidError extends Error {
  constructor() {
    super('config.json is not valid JSON at the moment. Fix the file, then try again.');
  }
}

/**
 * To be called before changing the config from the app. If the file on disk does not parse
 * (someone is editing it), saving would replace their edits with the last version that did.
 */
export function assertConfigWritable(): void {
  const path = configPath();
  if (!existsSync(path)) return;
  try {
    JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigInvalidError();
  }
}

/**
 * Reads the config file. It is read again every time it is needed, so edits apply without a
 * restart; that also means it can be caught half-written by an editor. An unreadable file is
 * therefore moved aside only when asked (at server start). Otherwise it is left alone and
 * the last settings that did parse stay in force.
 */
export function loadConfig(opts: { quarantineCorrupt?: boolean } = {}): { config: Config; warning: string | null } {
  const path = configPath();
  if (!existsSync(path)) return { config: defaultConfig(), warning: null };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return {
      config: lastGood.get(path) ?? defaultConfig(),
      warning: `Could not read ${path}: ${(e as Error).message}. Keeping the previous settings.`,
    };
  }
  try {
    const config = normalizeConfig(JSON.parse(text));
    lastGood.set(path, config);
    return { config, warning: null };
  } catch {
    if (!opts.quarantineCorrupt) {
      return {
        config: lastGood.get(path) ?? defaultConfig(),
        warning: 'config.json is not valid JSON; keeping the previous settings until it is fixed.',
      };
    }
    const bad = `${path}.bad`;
    try {
      rmSync(bad, { force: true });
      renameSync(path, bad);
    } catch {
      // Keeping the bad file aside is a courtesy; starting matters more.
    }
    return {
      config: defaultConfig(),
      warning: `config.json was not valid JSON. Starting with defaults; the old file was kept as config.json.bad (${bad}).`,
    };
  }
}

export function saveConfig(c: Config): void {
  // Written beside the file and renamed over it, so a reader never sees half a file.
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, path);
  lastGood.set(path, c);
}

export function readServerState(): ServerState | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(serverStatePath(), 'utf8'));
    if (!isRecord(raw)) return null;
    const { pid, port, token, hookToken, startedAt } = raw;
    if (typeof pid !== 'number' || typeof port !== 'number' || typeof token !== 'string') return null;
    if (typeof hookToken !== 'string' || typeof startedAt !== 'number') return null;
    const pageHost = typeof raw.pageHost === 'string' && /^[0-9a-f]{32}\.localhost$/.test(raw.pageHost) ? raw.pageHost : undefined;
    return { pid, port, token, hookToken, startedAt, ...(pageHost ? { pageHost } : {}) };
  } catch {
    return null;
  }
}

export function writeServerState(s: ServerState): void {
  const path = serverStatePath();
  // The token in this file grants a shell: keep it readable by the user only. Remove any
  // older file first, so the mode applies from creation and not after the token is written.
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every file system; the home folder's own permissions still apply.
  }
}

/** The page the shellyard command opens the browser on; it holds the token of the server. */
export function launcherPagePath(): string {
  return join(dataDir(), 'open.html');
}

/** Forgets the running server: its state file, and the launcher page that holds its token. */
export function clearServerState(): void {
  rmSync(serverStatePath(), { force: true });
  rmSync(launcherPagePath(), { force: true });
}
