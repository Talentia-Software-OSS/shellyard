import type { AreaRule, ConversationItem, ErrorReport, FileDiff, WorktreeChanges, FlowSummary, CreateSessionRequest, FolderListing, LanInfo, Meta, PermissionChoice, Profile, Schedule, ScheduleRun, SessionInfo, SoundFile, SoundLibrary, SoundSettings, Story, TerminalBackground, TerminalFont, WorktreeListing } from '../shared/types.js';
import type { SendOutcome } from './selection.js';
import type { Recipe } from '../shared/recipes.js';

/** What a schedule is made or changed with; a change sends only the fields it changes. */
export type ScheduleFields = Partial<Pick<Schedule, 'name' | 'prompt' | 'profileId' | 'model' | 'cwd' | 'storyId' | 'when' | 'enabled' | 'catchUp' | 'permissionMode'>>;

export interface StoryFields {
  name: string;
  ticket: string;
  cwd: string;
  color: string;
  /** '' plays the sounds of the events. */
  sound: string;
}

let token = '';
let onUnauthorized: () => void = () => {};

/** The page holds the token and sends it on every call; the browser never sends it by itself. */
export function configureApi(opts: { token: string; onUnauthorized: () => void }): void {
  token = opts.token;
  onUnauthorized = opts.onUnauthorized;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? { 'x-shellyard-token': token } : { 'x-shellyard-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // Not a JSON error body; the status line will do.
    }
    throw new Error(message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const imageUrls = new Map<string, Promise<string>>();

/**
 * A URL the page can draw a stored background image from. The image is fetched with the
 * token (a plain image address could not carry it) and handed over as a local object URL.
 */
export function backgroundUrl(name: string): Promise<string> {
  let url = imageUrls.get(name);
  if (!url) {
    url = fetch(`/api/backgrounds/${encodeURIComponent(name)}`, { headers: { 'x-shellyard-token': token } }).then(async (res) => {
      if (!res.ok) throw new Error(`Could not load the background image (${res.status}).`);
      return URL.createObjectURL(await res.blob());
    });
    url.catch(() => imageUrls.delete(name));
    imageUrls.set(name, url);
  }
  return url;
}

/** Sends an image file to be kept as a terminal background; returns the name it was given. */
export async function uploadBackground(file: File): Promise<string> {
  const res = await fetch('/api/backgrounds', { method: 'POST', headers: { 'x-shellyard-token': token, 'content-type': 'application/octet-stream' }, body: file });
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // The status line will do.
    }
    throw new Error(message);
  }
  return ((await res.json()) as { image: string }).image;
}

const soundUrls = new Map<string, Promise<string>>();

/** A local object URL for a stored sound, fetched with the token and kept for next time. */
export function soundUrl(id: string): Promise<string> {
  let url = soundUrls.get(id);
  if (!url) {
    url = fetch(`/api/sounds/${encodeURIComponent(id)}`, { headers: { 'x-shellyard-token': token } }).then(async (res) => {
      if (!res.ok) throw new Error(`Could not load the sound (${res.status}).`);
      return URL.createObjectURL(await res.blob());
    });
    url.catch(() => soundUrls.delete(id));
    soundUrls.set(id, url);
  }
  return url;
}

/** Sends an audio file to the sound library under its own file name. */
async function uploadSound(file: File): Promise<SoundFile> {
  const res = await fetch(`/api/sounds?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-shellyard-token': token, 'content-type': 'application/octet-stream' }, body: file });
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // The status line will do.
    }
    throw new Error(message);
  }
  return (await res.json()) as SoundFile;
}

export const api = {
  meta: (): Promise<Meta> => call('GET', '/api/meta'),
  /** Phone access with its links, which carry the token. */
  lan: (): Promise<LanInfo> => call('GET', '/api/lan'),
  /** Asked from a phone, the change follows the answer, which is then empty. */
  setLan: (enabled: boolean): Promise<LanInfo | undefined> => call('PUT', '/api/lan', { enabled }),
  newLanLink: (): Promise<LanInfo | undefined> => call('POST', '/api/lan/new-link'),
  createSession: (req: CreateSessionRequest): Promise<SessionInfo> => call('POST', '/api/sessions', req),
  updateSession: (id: string, patch: { name?: string; color?: string; background?: TerminalBackground | null; font?: TerminalFont | null }): Promise<SessionInfo> =>
    call('PATCH', `/api/sessions/${encodeURIComponent(id)}`, patch),
  /** Opens VS Code on the session's folder, on the computer ShellYard runs on. */
  openEditor: (id: string): Promise<void> => call('POST', `/api/sessions/${encodeURIComponent(id)}/editor`),
  ackSession: (id: string): Promise<SessionInfo> => call('POST', `/api/sessions/${encodeURIComponent(id)}/ack`),
  /** Answers the permission request `requestId`; refused (409) once it is no longer on screen. */
  answer: (id: string, requestId: string, choice: PermissionChoice): Promise<SessionInfo> =>
    call('POST', `/api/sessions/${encodeURIComponent(id)}/answer`, { requestId, choice }),
  createRule: (storyId: string, pattern: string): Promise<AreaRule> => call('POST', `/api/stories/${encodeURIComponent(storyId)}/rules`, { pattern }),
  updateRule: (id: string, patch: { enabled?: boolean; pattern?: string }): Promise<AreaRule> => call('PATCH', `/api/rules/${encodeURIComponent(id)}`, patch),
  deleteRule: (id: string): Promise<void> => call('DELETE', `/api/rules/${encodeURIComponent(id)}`),
  /** Types the same prompt into several sessions; each says whether it took it. */
  sendPrompt: (ids: string[], prompt: string): Promise<{ results: Array<{ id: string; outcome: SendOutcome }> }> => call('POST', '/api/sessions/prompt', { ids, prompt }),
  /** How the day went: time blocked on you, answers, the last hour per session. */
  flow: (): Promise<FlowSummary> => call('GET', '/api/flow'),
  recipes: (): Promise<Recipe[]> => call('GET', '/api/recipes'),
  createRecipe: (r: Omit<Recipe, 'id'>): Promise<Recipe> => call('POST', '/api/recipes', r),
  updateRecipe: (id: string, r: Omit<Recipe, 'id'>): Promise<Recipe> => call('PUT', `/api/recipes/${encodeURIComponent(id)}`, r),
  deleteRecipe: (id: string): Promise<void> => call('DELETE', `/api/recipes/${encodeURIComponent(id)}`),
  /** Worktree, area and sessions for a ticket, in one step. */
  startTicket: (recipeId: string, ticket: string): Promise<{ story: Story; sessions: SessionInfo[]; newBranch: boolean }> => call('POST', '/api/tickets', { recipeId, ticket }),
  /** Opens VS Code on the folder of an area. */
  openAreaEditor: (storyId: string): Promise<void> => call('POST', `/api/stories/${encodeURIComponent(storyId)}/editor`),
  deleteSession: (id: string): Promise<void> => call('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  reorderStories: (ids: string[]): Promise<Story[]> => call('PUT', '/api/stories/order', ids),
  reorderSessions: (ids: string[]): Promise<SessionInfo[]> => call('PUT', '/api/sessions/order', ids),
  reorderProfiles: (ids: string[]): Promise<Profile[]> => call('PUT', '/api/profiles/order', ids),
  sounds: (): Promise<SoundLibrary> => call('GET', '/api/sounds'),
  addSound: (file: File): Promise<SoundFile> => uploadSound(file),
  deleteSound: async (id: string): Promise<void> => {
    await call<void>('DELETE', `/api/sounds/${encodeURIComponent(id)}`);
    const cached = soundUrls.get(id);
    soundUrls.delete(id);
    cached?.then((u) => URL.revokeObjectURL(u), () => {});
  },
  /** The part of the sound that plays, in seconds; end null: to the end of the file. */
  trimSound: (id: string, trim: { start: number; end: number | null }): Promise<SoundFile> => call('PATCH', `/api/sounds/${encodeURIComponent(id)}`, trim),
  saveSoundSettings: (settings: SoundSettings): Promise<SoundSettings> => call('PUT', '/api/sounds/settings', settings),
  saveProfiles: (profiles: Profile[]): Promise<Profile[]> => call('PUT', '/api/profiles', profiles),
  conversations: (): Promise<ConversationItem[]> => call('GET', '/api/conversations'),
  /** Reopens a closed session; `storyId` puts it in that area (null: in none), omitted: where it was. */
  reopenClosed: (id: string, storyId?: string | null): Promise<SessionInfo> =>
    call('POST', `/api/closed/${encodeURIComponent(id)}/reopen`, storyId === undefined ? {} : { storyId }),
  forgetClosed: (id: string): Promise<void> => call('DELETE', `/api/closed/${encodeURIComponent(id)}`),
  folders: (path?: string): Promise<FolderListing> => call('GET', path ? `/api/folders?path=${encodeURIComponent(path)}` : '/api/folders'),
  moveSession: (id: string, storyId: string | null): Promise<SessionInfo> =>
    call('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { storyId }),
  createStory: (input: StoryFields): Promise<Story> => call('POST', '/api/stories', input),
  updateStory: (id: string, input: StoryFields): Promise<Story> => call('PATCH', `/api/stories/${encodeURIComponent(id)}`, input),
  deleteStory: (id: string): Promise<void> => call('DELETE', `/api/stories/${encodeURIComponent(id)}`),
  createSchedule: (fields: ScheduleFields): Promise<Schedule> => call('POST', '/api/schedules', fields),
  updateSchedule: (id: string, fields: ScheduleFields): Promise<Schedule> => call('PATCH', `/api/schedules/${encodeURIComponent(id)}`, fields),
  deleteSchedule: (id: string): Promise<void> => call('DELETE', `/api/schedules/${encodeURIComponent(id)}`),
  worktrees: (path: string): Promise<WorktreeListing | null> => call('GET', `/api/git/worktrees?path=${encodeURIComponent(path)}`),
  branches: (path: string): Promise<string[]> => call('GET', `/api/git/branches?path=${encodeURIComponent(path)}`),
  worktreeStatus: (path: string): Promise<{ dirty: boolean; unreachable: number }> => call('GET', `/api/git/status?path=${encodeURIComponent(path)}`),
  /** `base` is left out when absent; the server rejects null. */
  createWorktree: (b: { repo: string; path: string; branch: string; newBranch: boolean; base?: string }): Promise<WorktreeListing> => call('POST', '/api/git/worktrees', b),
  removeWorktree: (b: { repo: string; path: string; force: boolean; deleteBranch: boolean }): Promise<{ listing: WorktreeListing; warning: string | null }> =>
    call('DELETE', '/api/git/worktrees', b),
  switchBranch: (b: { path: string; branch: string; create: boolean }): Promise<void> => call('POST', '/api/git/switch', b),
  changes: (path: string): Promise<WorktreeChanges | null> => call('GET', `/api/git/changes?path=${encodeURIComponent(path)}`),
  diff: (path: string, file: string): Promise<FileDiff> => call('GET', `/api/git/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`),
  moveSessionToWorktree: (id: string, path: string): Promise<SessionInfo> => call('POST', `/api/sessions/${encodeURIComponent(id)}/worktree`, { path }),
  errors: (): Promise<ErrorReport[]> => call('GET', '/api/errors'),
  /** Null when the server wrote nothing (too many errors at once). */
  reportError: (b: { message: string; stack: string | null; context: string | null }): Promise<ErrorReport | null> => call('POST', '/api/errors', b),
  errorSeen: (id: string): Promise<void> => call('POST', `/api/errors/${encodeURIComponent(id)}/seen`),
  errorsSeen: (): Promise<void> => call('POST', '/api/errors/seen'),
  revealError: (id: string): Promise<void> => call('POST', `/api/errors/${encodeURIComponent(id)}/reveal`),
  runSchedule: (id: string): Promise<ScheduleRun> => call('POST', `/api/schedules/${encodeURIComponent(id)}/run`),
};
