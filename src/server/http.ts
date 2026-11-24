import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { ConversationItem, CreateSessionRequest, HookName, Meta } from '../shared/types.js';
import { healthProof, isChallenge, localGate, requestAuthorized, safeEqual, type Gate } from './auth.js';
import type { LanAccess } from './lan.js';
import { MAX_IMAGE_BYTES, readImage, saveImage } from './backgrounds.js';
import { MAX_SOUND_BYTES, SoundStore } from './sounds.js';
import { parseHookBody, parseHookRequest, permissionCommand } from './claude-launch.js';
import { RuleError, type RuleStore } from './area-rules.js';
import { suggestPattern } from '../shared/rules.js';
import { MAX_PROMPT } from '../shared/sessions.js';
import { RecipeError, type RecipeStore } from './recipes.js';
import { startFromTicket, TicketError } from './tickets.js';
import type { StatusLog } from './status-log.js';
import { revealCommand, type ErrorReporter } from './errors.js';
import { spawn } from 'node:child_process';
import { changesOf, diffOf, type ChangeTracker } from './changes.js';

/** The most sessions one prompt is sent to at once. */
const MAX_PROMPT_TARGETS = 50;
import type { ClosedStore } from './closed.js';
import { findConversation } from './conversations.js';
import { reopenEntry } from './restore.js';
import { FolderError, listFolders } from './folders.js';
import { branches, createWorktree, GitError, removeWorktree, retryWhileBusy, samePath, switchBranch, worktreesOf, worktreeStatus } from './git.js';
import { assertConfigWritable, ConfigInvalidError, loadConfig, normalizeProfiles, saveConfig } from './config.js';
import { parseTrim, TRIM_RULE } from '../shared/trim.js';
import { listConversations } from './conversations.js';
import { ScheduleError, type ScheduleStore } from './schedules.js';
import type { SessionManager } from './session-manager.js';
import type { StoryInput, StoryStore } from './stories.js';
import { parseStatusPayload, type UsageStore } from './usage.js';

export interface HttpDeps {
  manager: SessionManager;
  stories: StoryStore;
  sounds?: SoundStore;
  usage: UsageStore;
  closed: ClosedStore;
  schedules?: ScheduleStore;
  /** The area rules; without them every permission is asked. */
  rules?: RuleStore;
  /** The recipes of "Start from ticket". */
  recipes?: RecipeStore;
  /** How the day went: time blocked on the user, answers, the last hour per session. */
  flow?: StatusLog;
  /** Types a prompt into a new Claude session once it is ready (see PromptDelivery). */
  deliverPrompt?: (sessionId: string, prompt: string) => void;
  /** Opens the editor on a session's folder; returns why not, or null when it was started. */
  openEditor?: (session: { command: string; args: string[]; cwd: string }) => string | null;
  /** A hosted Claude session reported a status line: its main screen is up. */
  onClaudeStatus?: (sessionId: string) => void;
  /** A hosted Claude session took a prompt. */
  onPromptSubmitted?: (sessionId: string) => void;
  /** Writes a report for each unexpected error, and keeps those of this run for the page. */
  errors?: ErrorReporter;
  /** Shows a file in the system's file manager; returns why not, or null. Stands in for the real one in tests. */
  reveal?: (file: string) => string | null;
  /** A hosted Claude session reported a hook event (it used a tool, ended a turn...). */
  onHook?: (sessionId: string, name: HookName) => void;
  /** The figures of the worktrees' uncommitted changes, kept current by what the page reads. */
  changes?: ChangeTracker;
  port: number;
  /** The host name the page is served on in this start (see newPageHost). */
  pageHost: string;
  token: string;
  hookToken: string;
  /**
   * What this listener lets in. Absent: the loopback listener's own (the page of this start, the
   * token above). The phone listener passes its own gate (see lan.ts).
   */
  gate?: Gate;
  /** Phone access, switched on and off from the page; absent where there is none (tests). */
  lan?: Pick<LanAccess, 'info' | 'start' | 'stop' | 'newLink' | 'certificate'>;
  webDir: string;
  /** The package version this server runs, so a newer app can tell it is talking to an older server. */
  version?: string;
  onShutdown: () => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** What the hook prints for Claude Code when an area rule allows a request. */
export const ALLOW_BY_RULE = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } as const;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const base: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers };
  if (body === undefined) {
    res.writeHead(status, base).end();
    return;
  }
  if (typeof body === 'string') {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...base }).end(body);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...base }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Reads a body as bytes, for uploads. */
function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      req.resume();
      reject(new HttpError(413, 'File too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) {
        failed = true;
        reject(new HttpError(413, 'File too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolveBody(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const v = await readJson(req);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'Body must be a JSON object');
  return v as Record<string, unknown>;
}

/** The body of an order request: a list of ids. */
async function readIdList(req: IncomingMessage): Promise<string[]> {
  const v = await readJson(req);
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, 'Body must be a list of ids');
  return v as string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A folder named by a request: only a non-empty absolute path is taken. */
function absolutePath(v: unknown, label = 'path'): string {
  if (typeof v !== 'string' || v.length === 0 || !isAbsolute(v)) throw new HttpError(400, `${label} must be an absolute path`);
  return v;
}

/** What git refuses is the client's to correct: it is answered with git's reason. */
async function gitCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GitError) throw new HttpError(400, e.message);
    throw e;
  }
}

/** Shows a file in the system's file manager, without waiting for it. */
function revealFile(file: string): string | null {
  const cmd = revealCommand(file);
  try {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: cmd.verbatim });
    child.on('error', () => undefined);
    child.unref();
    return null;
  } catch (e) {
    return `Could not open the folder: ${(e as Error).message}`;
  }
}

/** How long removing a worktree waits for the processes of closed sessions in it to end. */
const FOLDER_RELEASE_MS = 3000;

/** Resolves once `done` holds, checking every 100 ms, or after `timeoutMs` whatever it says. */
async function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

/** The conversation a hook or status report names, if any. */
const reportedConversation = (body: unknown): unknown => (body as { session_id?: unknown } | null)?.session_id;

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'Bad session id');
  }
}

function toCreateRequest(b: Record<string, unknown>): CreateSessionRequest {
  const req: CreateSessionRequest = {};
  if (str(b.profileId)) req.profileId = str(b.profileId);
  if (b.kind === 'claude' || b.kind === 'shell') req.kind = b.kind;
  if (str(b.command) !== undefined) req.command = str(b.command);
  if (Array.isArray(b.args)) req.args = b.args.filter((a): a is string => typeof a === 'string');
  else if (b.args !== undefined) req.args = [];
  if (str(b.name) !== undefined) req.name = str(b.name);
  if (str(b.cwd) !== undefined) req.cwd = str(b.cwd);
  if (str(b.color) !== undefined) req.color = str(b.color);
  if (b.model === null || typeof b.model === 'string') req.model = b.model;
  if (b.storyId === null || typeof b.storyId === 'string') req.storyId = b.storyId;
  if (typeof b.resume === 'string') req.resume = b.resume;
  // Present at all (null included) means the request decides; the manager validates it.
  if ('background' in b) req.background = (b.background ?? null) as CreateSessionRequest['background'];
  if ('font' in b) req.font = (b.font ?? null) as CreateSessionRequest['font'];
  return req;
}

function toStoryInput(b: Record<string, unknown>): StoryInput {
  return { name: str(b.name), ticket: str(b.ticket), cwd: str(b.cwd), color: str(b.color), sound: str(b.sound) };
}

/**
 * The page of any address other than this start's own: the app is not served there, so a
 * bookmark or an old tab says how to open it instead of failing silently.
 */
/** Where a phone downloads the root of phone access. */
const CERTIFICATE_PATH = '/shellyard-certificate.crt';

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page a new phone opens first (phone access): it downloads the root and says how to make
 * the phone trust it. No script, no secret; reached once by going past the phone's warning.
 */
function sendSetupPage(res: ServerResponse, root: { name: string; fingerprint: string }, method: string): void {
  const name = escapeHtml(root.name);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ShellYard: set up this phone</title>
<body style="font:16px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:40rem;color:#1b1f27;background:#fff">
<h1 style="font-size:1.4rem">Set up this phone for ShellYard</h1>
<p>Once per phone: install the certificate of <b>${name}</b>. From then on this phone checks that it really talks to ShellYard on that computer, and the connection is encrypted. The certificate can only vouch for addresses on private networks, never for a website.</p>
<p><a href="${CERTIFICATE_PATH}" style="display:inline-block;padding:.7rem 1.1rem;border-radius:8px;background:#1f4f9e;color:#fff;text-decoration:none;font-weight:600">Download the certificate</a></p>
<h2 style="font-size:1.1rem">iPhone or iPad (Safari)</h2>
<ol><li>Tap <b>Download the certificate</b>, then <b>Allow</b>.</li><li>Open <b>Settings</b>, tap <b>Profile Downloaded</b>, then <b>Install</b>.</li><li>Open <b>Settings › General › About › Certificate Trust Settings</b> and switch on <b>${name}</b>.</li></ol>
<h2 style="font-size:1.1rem">Android (Chrome)</h2>
<ol><li>Tap <b>Download the certificate</b>.</li><li>Open <b>Settings</b>, search for <b>CA certificate</b> (often under Security › Encryption &amp; credentials › Install a certificate), choose <b>CA certificate</b> and pick the file you downloaded.</li></ol>
<p>Then, on the computer, show the second code (<b>Open ShellYard</b>) and scan it. Close this page: once the certificate is installed, the phone no longer warns, and should it ever warn about ShellYard again, do not go on.</p>
<p style="font-size:.85rem;color:#555;word-break:break-all">Fingerprint (SHA-256), the same as on the computer and in the phone's certificate details:<br><code>${escapeHtml(root.fingerprint)}</code></p>
</body>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(method === 'HEAD' ? undefined : html);
}

/** The root of phone access, in the form phones install as a CA certificate. */
function sendCertificate(res: ServerResponse, der: Buffer, method: string): void {
  res.writeHead(200, {
    'content-type': 'application/x-x509-ca-cert',
    'content-disposition': 'attachment; filename="ShellYard-certificate.crt"',
    'content-length': String(der.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : der);
}

function sendOpenNotice(res: ServerResponse, stale: boolean, method: string): void {
  const text = stale
    ? 'ShellYard was restarted since this page was opened. Run <code>shellyard</code> (or open the ShellYard app) to open it again.'
    : 'Open ShellYard with the <code>shellyard</code> command or the ShellYard app: each start opens it on an address of its own.';
  const html = `<!doctype html><meta charset="utf-8"><title>ShellYard</title><body style="font:16px system-ui,sans-serif;margin:3rem;max-width:40rem"><h1>ShellYard</h1><p>${text}</p></body>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(method === 'HEAD' ? undefined : html);
}

function serveStatic(webDir: string, pathname: string, method: string, res: ServerResponse, wsOrigin: string): void {
  const root = resolve(webDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(res, 400, { error: 'Bad path' });
    return;
  }
  if (decoded.includes('\0')) {
    send(res, 400, { error: 'Bad path' });
    return;
  }
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  let file = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  // Whatever the path decodes to, it must stay inside the web folder.
  const inside = file === root || file.startsWith(root + sep);
  if (!inside || !isFile(file)) {
    // Unknown page paths get the app (it routes in the browser); missing assets are a 404.
    if (inside && extname(decoded) !== '') {
      send(res, 404, { error: 'Not found' });
      return;
    }
    file = resolve(root, 'index.html');
    if (!isFile(file)) {
      send(res, 404, { error: 'The web UI is not built' });
      return;
    }
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'private, max-age=3600',
  };
  if (type.startsWith('text/html')) {
    // 'self' does not cover the ws: scheme in every browser, so the WebSocket is named.
    headers['content-security-policy'] =
      // blob: is how the page shows a terminal background it fetched with its token.
      // blob: is also how it plays a sound the user added (fetched the same way).
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      `connect-src 'self' ${wsOrigin}; ` +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  }
  res.writeHead(200, headers);
  if (method === 'HEAD') {
    res.end();
    return;
  }
  // pipeline closes the file when the client goes away mid-transfer; a plain pipe would keep
  // it open, and a few aborted downloads would use up the server's file descriptors.
  pipeline(createReadStream(file), res, () => undefined);
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { manager } = deps;
  const sounds = deps.sounds ?? new SoundStore(deps.stories);
  const gate = deps.gate ?? localGate(deps.port, deps.pageHost, deps.token);

  /** Claude Code names the conversation in every report; that is how a restart can resume it. */
  function noteConversation(sessionId: string, body: unknown): void {
    const reported = (body as { session_id?: unknown } | null)?.session_id;
    if (typeof reported === 'string') manager.setConversation(sessionId, reported);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostKind = gate.classify(req);
    if (hostKind === 'foreign') {
      send(res, 403, { error: 'Forbidden host' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // The hooks, the status reports and the shutdown are for the processes of this computer,
    // which use the loopback listener: the phone listener does not know them.
    if (!gate.local && (path.startsWith('/api/hooks/') || path.startsWith('/api/status/') || path === '/api/shutdown')) {
      throw new HttpError(404, 'Not found');
    }

    if (path === '/api/health') {
      // Open to anyone, so it says nothing that identifies this instance. The shellyard
      // command tells its own server apart by the proof, which only the token holder can make.
      const challenge = url.searchParams.get('challenge');
      const proof = gate.local && isChallenge(challenge) ? healthProof(deps.token, challenge) : undefined;
      send(res, 200, { ok: true, app: 'shellyard', version: deps.version, ...(proof ? { proof } : {}) });
      return;
    }

    // Hook events come from Claude Code processes, which hold only the hook token.
    const hookMatch = /^\/api\/hooks\/([^/]+)$/.exec(path);
    if (hookMatch) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const given = req.headers['x-shellyard-hook-token'];
      if (typeof given !== 'string' || !safeEqual(given, deps.hookToken)) throw new HttpError(403, 'Forbidden');
      const raw = await readJson(req);
      const parsed = parseHookBody(raw);
      if (!parsed) throw new HttpError(400, 'Unknown hook event');
      const hookedId = decodeId(hookMatch[1]!);
      // A late report from the process a restart replaced: acknowledged, and nothing more.
      if (manager.isRetiredConversation(hookedId, reportedConversation(raw))) {
        const live = manager.get(hookedId);
        if (!live || live.status === 'exited') throw new HttpError(404, 'No such live session');
        send(res, 204);
        return;
      }
      // A command an area rule allows is answered here, and the session never stops: the hook
      // hands the decision to Claude Code, which then shows no question at all.
      const command = permissionCommand(raw);
      if (parsed.name === 'PermissionRequest' && deps.rules && command !== null) {
        const live = manager.get(hookedId);
        if (!live || live.status === 'exited') throw new HttpError(404, 'No such live session');
        if (deps.rules.decide(live.storyId, 'Bash', command)) {
          noteConversation(hookedId, raw);
          manager.setLiveCwd(hookedId, (raw as { cwd?: unknown }).cwd);
          return send(res, 200, ALLOW_BY_RULE);
        }
      }
      if (!manager.hook(hookedId, parsed.name, parsed.idleReminder, parseHookRequest(raw), command)) throw new HttpError(404, 'No such live session');
      noteConversation(hookedId, raw);
      manager.setLiveCwd(hookedId, (raw as { cwd?: unknown }).cwd);
      if (parsed.name === 'UserPromptSubmit') deps.onPromptSubmitted?.(hookedId);
      deps.onHook?.(hookedId, parsed.name);
      send(res, 204);
      return;
    }

    // Status reports come from the status-line command of hosted Claude sessions, which,
    // like the hooks, holds only the hook token.
    const statusMatch = /^\/api\/status\/([^/]+)$/.exec(path);
    if (statusMatch) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const given = req.headers['x-shellyard-hook-token'];
      if (typeof given !== 'string' || !safeEqual(given, deps.hookToken)) throw new HttpError(403, 'Forbidden');
      const rawStatus = await readJson(req);
      const payload = parseStatusPayload(rawStatus);
      if (!payload) throw new HttpError(400, 'Not a status payload');
      const id = decodeId(statusMatch[1]!);
      // An exited session may still deliver its last figures; an unknown one is refused.
      const session = manager.get(id);
      if (!session) throw new HttpError(404, 'No such session');
      // A late report from the process a restart replaced: its figures and folder are not this one's.
      if (manager.isRetiredConversation(id, reportedConversation(rawStatus))) {
        send(res, 204);
        return;
      }
      const story = session.storyId ? deps.stories.list().find((s) => s.id === session.storyId) : undefined;
      // The conversation is named first, so that what is counted here is set against it:
      // the same spending turns up again in the transcript when the session ends.
      noteConversation(id, rawStatus);
      deps.usage.record(id, payload, {
        storyId: story?.id ?? null,
        storyName: story?.name ?? null,
        resumed: session.resumed,
        conversationId: manager.conversationOf(id),
      });
      deps.usage.learnModelName(payload.modelId, payload.modelName);
      // A session a schedule opened is new, never resumed: its running total is the run's cost.
      if (!session.resumed) deps.schedules?.observeCost(id, payload.costUsd);
      noteConversation(id, rawStatus);
      if (payload.modelName) manager.setModel(id, payload.modelName);
      const reported = rawStatus as { cwd?: unknown; workspace?: { current_dir?: unknown } | null };
      manager.setLiveCwd(id, reported.workspace?.current_dir ?? reported.cwd);
      manager.noteStatusLine(id);
      deps.onClaudeStatus?.(id);
      send(res, 204);
      return;
    }

    // The app's own files hold no secret, so they need no credential. The page receives the
    // token in the fragment of its address, which browsers never send to a server. It is
    // served only on the host name of this start; on any other address the browser is only
    // told how to open it.
    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      // A new phone's first visit: the root to install, and how. Public, like the root itself.
      if (!gate.local && deps.lan && (path === '/setup' || path === CERTIFICATE_PATH)) {
        const root = deps.lan.certificate();
        if (path === '/setup') sendSetupPage(res, root, method);
        else sendCertificate(res, root.der, method);
        return;
      }
      if (hostKind === 'page') serveStatic(deps.webDir, path, method, res, gate.wsOrigin(req));
      else sendOpenNotice(res, hostKind === 'stale-page', method);
      return;
    }

    // A tab left open from an earlier start: told, like a stale token, to open ShellYard again.
    if (hostKind === 'stale-page') {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (!requestAuthorized(req.headers, gate.token())) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }

    // The token header already cannot be set by another site without a preflight we never
    // approve. Refusing a foreign Origin as well costs nothing and guards against mistakes.
    if (method !== 'GET' && req.headers.origin !== undefined && !gate.originAllowed(req.headers.origin, req)) {
      throw new HttpError(403, 'Forbidden origin');
    }

    if (path === '/api/sessions') {
      if (method === 'GET') return send(res, 200, manager.list());
      if (method === 'POST') return send(res, 201, manager.create(toCreateRequest(await readObject(req))));
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/sessions/order') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      manager.reorder(await readIdList(req));
      return send(res, 200, manager.list());
    }

    // The same prompt typed into several sessions; each says whether it took it.
    if (path === '/api/sessions/prompt') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const b = await readObject(req);
      const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === 'string'))] : [];
      const prompt = typeof b.prompt === 'string' ? b.prompt : '';
      if (ids.length === 0 || ids.length > MAX_PROMPT_TARGETS) throw new HttpError(400, `Pick between 1 and ${MAX_PROMPT_TARGETS} sessions.`);
      if (!prompt.trim()) throw new HttpError(400, 'Write the prompt to send.');
      if (prompt.length > MAX_PROMPT) throw new HttpError(400, `A prompt is at most ${MAX_PROMPT} characters.`);
      return send(res, 200, { results: ids.map((id) => ({ id, outcome: manager.typePrompt(id, prompt) })) });
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/ack|\/editor|\/worktree|\/answer)?$/.exec(path);
    if (sessionMatch) {
      const id = decodeId(sessionMatch[1]!);
      if (sessionMatch[2] === '/answer') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const b = await readObject(req);
        const choice = b.choice === 'once' || b.choice === 'deny' || b.choice === 'area' ? b.choice : null;
        if (typeof b.requestId !== 'string' || !choice) throw new HttpError(400, 'Give the request id and a choice: once, area or deny');
        const STALE = 'That request is no longer waiting: it was answered in the terminal, or another one came.';
        // For "always in this area", everything the rule needs is checked before any key is pressed.
        let rule: { storyId: string; pattern: string } | null = null;
        if (choice === 'area') {
          const s = manager.get(id);
          if (!s) throw new HttpError(404, 'No such session');
          if (s.pending?.id !== b.requestId || s.pending.kind !== 'permission') throw new HttpError(409, STALE);
          if (!deps.rules) throw new HttpError(409, 'Area rules are not available here.');
          if (!s.storyId || !deps.stories.list().some((x) => x.id === s.storyId)) throw new HttpError(409, 'This session is in no area. Put it in one first, or allow this once.');
          if (s.pending.tool !== 'Bash') throw new HttpError(409, 'Only Bash commands can be allowed for a whole area. Allow this once.');
          const command = manager.pendingCommand(id, b.requestId);
          if (command === null) throw new HttpError(409, 'Claude Code did not say which command this is, so it cannot become a rule. Allow it once.');
          const pattern = suggestPattern(command);
          if (!pattern) throw new HttpError(409, 'This command chains, pipes, redirects or substitutes, so it cannot become a rule. Allow it once.');
          rule = { storyId: s.storyId, pattern };
        }
        const outcome = manager.answer(id, b.requestId, choice);
        if (outcome === 'missing') throw new HttpError(404, 'No such session');
        if (outcome === 'stale') throw new HttpError(409, STALE);
        // The rule follows the answer: a request settled meanwhile in the terminal adds none.
        if (rule && deps.rules) {
          try {
            deps.rules.create(rule.storyId, rule.pattern);
          } catch (e) {
            if (e instanceof RuleError) throw new HttpError(409, `Allowed once, but the rule was not added: ${e.message}`);
            throw e;
          }
        }
        return send(res, 200, manager.get(id));
      }
      if (sessionMatch[2] === '/worktree') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const s = manager.get(id);
        if (!s) throw new HttpError(404, 'No such session');
        const target = absolutePath((await readObject(req)).path);
        // A WSL session names its folder itself (--cd): restarting it elsewhere would not move it.
        if (s.args.includes('--cd')) throw new HttpError(422, 'This session sets its own folder (--cd), so it cannot be moved to another worktree');
        // Only a worktree of the session's own repository, as git lists it.
        const listing = await worktreesOf(s.git?.worktree ?? s.liveCwd ?? s.cwd);
        const worktree = listing?.worktrees.find((w) => samePath(w.path, target));
        if (!worktree) throw new HttpError(422, "Not a worktree of this session's repository");
        if (worktree.prunable) throw new HttpError(422, 'The folder of that worktree is missing');
        const restarted = manager.restartIn(id, worktree.path);
        if (!restarted) throw new HttpError(404, 'No such session');
        return send(res, 200, restarted);
      }
      if (sessionMatch[2] === '/editor') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const s = manager.get(id);
        if (!s) throw new HttpError(404, 'No such session');
        // The folder is the session's own, never one the request names.
        const problem = deps.openEditor ? deps.openEditor({ command: s.command, args: s.args, cwd: s.cwd }) : 'Opening an editor is not available here.';
        if (problem) throw new HttpError(409, problem);
        return send(res, 204);
      }
      if (sessionMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const s = manager.ack(id);
        if (!s) throw new HttpError(404, 'No such session');
        return send(res, 200, s);
      }
      if (method === 'PATCH') {
        const b = await readObject(req);
        const storyId = b.storyId === null || typeof b.storyId === 'string' ? b.storyId : undefined;
        const background = 'background' in b ? ((b.background ?? null) as CreateSessionRequest['background']) : undefined;
        const font = 'font' in b ? ((b.font ?? null) as CreateSessionRequest['font']) : undefined;
        const s = manager.update(id, { name: str(b.name), color: str(b.color), storyId, background, font });
        if (!s) throw new HttpError(404, 'No such session');
        return send(res, 200, s);
      }
      if (method === 'DELETE') {
        if (!manager.remove(id)) throw new HttpError(404, 'No such session');
        deps.usage.forgetSession(id);
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/stories/order') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, deps.stories.reorder(await readIdList(req)));
    }

    if (path === '/api/profiles/order') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      const ids = await readIdList(req);
      assertConfigWritable();
      const { config } = loadConfig();
      config.profileOrder = ids;
      saveConfig(config);
      return send(res, 200, manager.profiles());
    }

    if (path === '/api/stories') {
      if (method === 'GET') return send(res, 200, deps.stories.list());
      if (method === 'POST') {
        const input = toStoryInput(await readObject(req));
        if (!input.name || !input.name.trim()) throw new HttpError(400, 'A story needs a name.');
        return send(res, 201, deps.stories.create(input));
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const storyMatch = /^\/api\/stories\/([^/]+)(\/editor|\/rules)?$/.exec(path);
    if (storyMatch) {
      const id = decodeId(storyMatch[1]!);
      if (storyMatch[2] === '/rules') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        if (!deps.rules) throw new HttpError(409, 'Area rules are not available here.');
        if (!deps.stories.list().some((s) => s.id === id)) throw new HttpError(404, 'No such story');
        const pattern = (await readObject(req)).pattern;
        if (typeof pattern !== 'string') throw new HttpError(400, 'Give the command the rule allows, such as "dotnet test *".');
        try {
          return send(res, 201, deps.rules.create(id, pattern));
        } catch (e) {
          if (e instanceof RuleError) throw new HttpError(400, e.message);
          throw e;
        }
      }
      if (storyMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const story = deps.stories.list().find((s) => s.id === id);
        if (!story) throw new HttpError(404, 'No such story');
        if (!story.cwd) throw new HttpError(409, 'This area has no folder. Set one by editing the area.');
        // The folder is the area's own, never one the request names.
        const problem = deps.openEditor ? deps.openEditor({ command: '', args: [], cwd: story.cwd }) : 'Opening an editor is not available here.';
        if (problem) throw new HttpError(409, problem);
        return send(res, 204);
      }
      if (method === 'PATCH') {
        const story = deps.stories.update(id, toStoryInput(await readObject(req)));
        if (!story) throw new HttpError(404, 'No such story');
        return send(res, 200, story);
      }
      if (method === 'DELETE') {
        if (!deps.stories.remove(id)) throw new HttpError(404, 'No such story');
        // Its sessions are not stopped: they simply no longer belong to a story.
        manager.clearStory(id);
        deps.schedules?.clearStory(id);
        deps.rules?.removeStory(id);
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const ruleMatch = /^\/api\/rules\/([^/]+)$/.exec(path);
    if (ruleMatch) {
      if (!deps.rules) throw new HttpError(409, 'Area rules are not available here.');
      const id = decodeId(ruleMatch[1]!);
      if (method === 'PATCH') {
        const b = await readObject(req);
        const patch = { enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, pattern: typeof b.pattern === 'string' ? b.pattern : undefined };
        try {
          const rule = deps.rules.update(id, patch);
          if (!rule) throw new HttpError(404, 'No such rule');
          return send(res, 200, rule);
        } catch (e) {
          if (e instanceof RuleError) throw new HttpError(400, e.message);
          throw e;
        }
      }
      if (method === 'DELETE') {
        if (!deps.rules.remove(id)) throw new HttpError(404, 'No such rule');
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/backgrounds') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const name = saveImage(await readBytes(req, MAX_IMAGE_BYTES));
      if (!name) throw new HttpError(400, 'Not an image ShellYard can use. Use a PNG, JPEG, WebP or GIF file.');
      return send(res, 201, { image: name });
    }

    const imageMatch = /^\/api\/backgrounds\/([^/]+)$/.exec(path);
    if (imageMatch) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const image = readImage(decodeId(imageMatch[1]!));
      if (!image) throw new HttpError(404, 'No such image');
      res.writeHead(200, { 'content-type': image.type, 'content-length': String(image.bytes.length), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' });
      res.end(image.bytes);
      return;
    }

    if (path === '/api/sounds') {
      if (method === 'GET') return send(res, 200, { sounds: sounds.list(), settings: sounds.settings() });
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const bytes = await readBytes(req, MAX_SOUND_BYTES);
      const file = sounds.add(bytes, url.searchParams.get('name') ?? '');
      if (!file) throw new HttpError(400, 'Not a sound ShellYard can use. Use an MP3, WAV or OGG file.');
      return send(res, 201, file);
    }

    if (path === '/api/sounds/settings') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, sounds.setSettings(await readObject(req)));
    }

    const soundMatch = /^\/api\/sounds\/([^/]+)$/.exec(path);
    if (soundMatch) {
      const id = decodeId(soundMatch[1]!);
      if (method === 'GET') {
        const sound = sounds.read(id);
        if (!sound) throw new HttpError(404, 'No such sound');
        res.writeHead(200, { 'content-type': sound.type, 'content-length': String(sound.bytes.length), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' });
        res.end(sound.bytes);
        return;
      }
      if (method === 'DELETE') {
        if (!sounds.remove(id)) throw new HttpError(404, 'No such sound');
        return send(res, 204);
      }
      if (method === 'PATCH') {
        const body = await readObject(req);
        if (!sounds.list().some((s) => s.id === id)) throw new HttpError(404, 'No such sound');
        const trim = parseTrim(body.start, body.end);
        if (!trim) throw new HttpError(400, TRIM_RULE);
        const file = sounds.setTrim(id, trim);
        if (!file) throw new HttpError(404, 'No such sound');
        return send(res, 200, file);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (deps.schedules && (path === '/api/schedules' || path.startsWith('/api/schedules/'))) {
      const schedules = deps.schedules;
      // What a schedule refuses is the client's to correct: it is answered with the reason.
      const checked = <T>(fn: () => T): T => {
        try {
          return fn();
        } catch (e) {
          if (e instanceof ScheduleError) throw new HttpError(400, e.message);
          throw e;
        }
      };
      if (path === '/api/schedules') {
        if (method === 'GET') return send(res, 200, schedules.list());
        if (method === 'POST') {
          const body = await readObject(req);
          return send(res, 201, checked(() => schedules.create(body)));
        }
        throw new HttpError(405, 'Method not allowed');
      }
      const scheduleMatch = /^\/api\/schedules\/([^/]+)(\/run)?$/.exec(path);
      if (!scheduleMatch) throw new HttpError(404, 'Not found');
      const id = decodeId(scheduleMatch[1]!);
      if (scheduleMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const run = schedules.runNow(id);
        if (!run) throw new HttpError(404, 'No such schedule');
        return send(res, 200, run);
      }
      if (method === 'PATCH') {
        const body = await readObject(req);
        const schedule = checked(() => schedules.update(id, body));
        if (!schedule) throw new HttpError(404, 'No such schedule');
        return send(res, 200, schedule);
      }
      if (method === 'DELETE') {
        if (!schedules.remove(id)) throw new HttpError(404, 'No such schedule');
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/closed') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, deps.closed.list());
    }

    const closedMatch = /^\/api\/closed\/([^/]+)(\/reopen)?$/.exec(path);
    if (closedMatch) {
      const id = decodeId(closedMatch[1]!);
      if (closedMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        // An empty body reopens it where it was; a body may name another area, or none.
        const body = Number(req.headers['content-length'] ?? 0) > 0 ? await readObject(req) : {};
        const entry = deps.closed.take(id);
        if (!entry) throw new HttpError(404, 'No such closed session');
        const storyId = body.storyId === null || typeof body.storyId === 'string' ? body.storyId : entry.storyId;
        const session = reopenEntry(manager, { ...entry, storyId }, findConversation);
        if (session.error) {
          // Not reopened after all: it stays in the list, and no failed session is left behind.
          manager.remove(session.id);
          deps.closed.putBack(entry);
          throw new HttpError(409, session.error);
        }
        // The ended session it came from may still be listed; it has been replaced.
        if (manager.get(entry.sessionId)?.status === 'exited') manager.remove(entry.sessionId);
        return send(res, 201, session);
      }
      if (method !== 'DELETE') throw new HttpError(405, 'Method not allowed');
      if (!deps.closed.remove(id)) throw new HttpError(404, 'No such closed session');
      return send(res, 204);
    }

    if (path === '/api/conversations') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const open = manager.openConversations();
      const items: ConversationItem[] = listConversations().map((c) => ({ ...c, openIn: open.get(c.id) ?? null }));
      return send(res, 200, items);
    }

    if (path === '/api/folders') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      try {
        return send(res, 200, listFolders(url.searchParams.get('path') ?? undefined));
      } catch (e) {
        if (e instanceof FolderError) throw new HttpError(400, e.message);
        throw e;
      }
    }

    if (path === '/api/flow') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      if (!deps.flow) throw new HttpError(409, 'The flow is not recorded here.');
      return send(res, 200, deps.flow.summary());
    }

    // The recipes of "Start from ticket".
    if (path === '/api/recipes' || /^\/api\/recipes\/[^/]+$/.test(path)) {
      const recipes = deps.recipes;
      if (!recipes) throw new HttpError(409, 'Recipes are not available here.');
      const id = path === '/api/recipes' ? null : decodeId(path.slice('/api/recipes/'.length));
      const guarded = <T,>(fn: () => T): T => {
        try {
          return fn();
        } catch (e) {
          if (e instanceof RecipeError) throw new HttpError(400, e.message);
          throw e;
        }
      };
      if (id === null && method === 'GET') return send(res, 200, recipes.list());
      if (id === null && method === 'POST') {
        const body = await readObject(req);
        return send(res, 201, guarded(() => recipes.create(body)));
      }
      if (id !== null && method === 'PUT') {
        const body = await readObject(req);
        const recipe = guarded(() => recipes.update(id, body));
        if (!recipe) throw new HttpError(404, 'No such recipe');
        return send(res, 200, recipe);
      }
      if (id !== null && method === 'DELETE') {
        if (!guarded(() => recipes.remove(id))) throw new HttpError(404, 'No such recipe');
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // Start from ticket: worktree, area and sessions in one step.
    if (path === '/api/tickets') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const recipes = deps.recipes;
      if (!recipes) throw new HttpError(409, 'Recipes are not available here.');
      const b = await readObject(req);
      if (typeof b.recipeId !== 'string' || typeof b.ticket !== 'string') throw new HttpError(400, 'Give a recipe and a ticket code.');
      try {
        const started = await startFromTicket(
          {
            recipe: (rid) => recipes.get(rid),
            stories: deps.stories,
            profiles: () => manager.profiles(),
            createSession: (r) => manager.create(r),
            deliverPrompt: (sid, prompt) => deps.deliverPrompt?.(sid, prompt),
            git: { branches, createWorktree, removeWorktree },
            gitMessage: (e) => {
              if (e instanceof GitError) return e.message;
              throw e;
            },
            refreshGit: (repo) => manager.refreshGitIn(repo),
          },
          b.recipeId,
          b.ticket,
        );
        return send(res, 201, started);
      } catch (e) {
        if (e instanceof TicketError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    if (path === '/api/git/worktrees' || path === '/api/git/branches' || path === '/api/git/status') {
      if (method === 'GET') {
        const folder = absolutePath(url.searchParams.get('path'));
        if (path === '/api/git/worktrees') return send(res, 200, await worktreesOf(folder));
        if (path === '/api/git/branches') return send(res, 200, await branches(folder));
        return send(res, 200, await gitCall(() => worktreeStatus(folder)));
      }
      if (path === '/api/git/worktrees' && method === 'POST') {
        const b = await readObject(req);
        const repo = absolutePath(b.repo, 'repo');
        const target = absolutePath(b.path);
        if (typeof b.branch !== 'string') throw new HttpError(400, 'branch must be a string');
        if (b.base !== undefined && typeof b.base !== 'string') throw new HttpError(400, 'base must be a string');
        const branch = b.branch;
        const base = b.base as string | undefined;
        const listing = await gitCall(() => createWorktree(repo, { path: target, branch, newBranch: b.newBranch === true, base }));
        await manager.refreshGitIn(repo);
        return send(res, 201, listing);
      }
      if (path === '/api/git/worktrees' && method === 'DELETE') {
        const b = await readObject(req);
        const repo = absolutePath(b.repo, 'repo');
        const target = absolutePath(b.path);
        // A session closed just before (as the worktrees dialog does) may still hold the folder for a
        // moment on Windows: wait (a little) for its process to end, and should git still find the
        // folder busy, try again a few times.
        await waitFor(() => !manager.hasLiveProcessIn(target), FOLDER_RELEASE_MS);
        const result = await gitCall(() => retryWhileBusy(() => removeWorktree(repo, target, { force: b.force === true, deleteBranch: b.deleteBranch === true })));
        // The sessions that were in the removed worktree are no longer in the listing.
        const inRemoved = manager.list().filter((s) => s.git && samePath(s.git.worktree, target));
        await Promise.all([manager.refreshGitIn(repo), ...inRemoved.map((s) => manager.refreshGit(s.id))]);
        return send(res, 200, result);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // The uncommitted changes of a worktree, and the diff of one of its files.
    if (path === '/api/git/changes') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const folder = absolutePath(url.searchParams.get('path'));
      const changes = await gitCall(() => changesOf(folder));
      deps.changes?.record(folder, changes);
      return send(res, 200, changes);
    }

    if (path === '/api/git/diff') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const folder = absolutePath(url.searchParams.get('path'));
      const file = url.searchParams.get('file');
      if (!file) throw new HttpError(400, 'file is required');
      return send(res, 200, await gitCall(() => diffOf(folder, file)));
    }

    if (path === '/api/git/switch') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const b = await readObject(req);
      const target = absolutePath(b.path);
      if (typeof b.branch !== 'string') throw new HttpError(400, 'branch must be a string');
      const branch = b.branch;
      // Only the top folder of a worktree, as its own repository lists it.
      const listing = await worktreesOf(target);
      if (!listing?.worktrees.some((w) => samePath(w.path, target))) throw new HttpError(422, 'Not a worktree');
      await gitCall(() => switchBranch(target, { branch, create: b.create === true }));
      await manager.refreshGitIn(target);
      return send(res, 204);
    }

    // Unexpected errors: those of the server, and those the page reports.
    if (deps.errors && (path === '/api/errors' || path.startsWith('/api/errors/'))) {
      const errors = deps.errors;
      if (path === '/api/errors') {
        if (method === 'GET') return send(res, 200, errors.list());
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const b = await readObject(req);
        if (typeof b.message !== 'string' || b.message.trim() === '') throw new HttpError(400, 'message must be a non-empty string');
        if (b.stack !== undefined && b.stack !== null && typeof b.stack !== 'string') throw new HttpError(400, 'stack must be a string');
        if (b.context !== undefined && b.context !== null && typeof b.context !== 'string') throw new HttpError(400, 'context must be a string');
        const report = errors.report({ source: 'page', error: b.message, stack: (b.stack as string | null | undefined) ?? null, context: (b.context as string | null | undefined) ?? null });
        return send(res, 200, report);
      }
      if (path === '/api/errors/seen') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        errors.dismissAll();
        return send(res, 204);
      }
      const m = /^\/api\/errors\/([^/]+)\/(seen|reveal)$/.exec(path);
      if (!m) throw new HttpError(404, 'Not found');
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const id = decodeId(m[1]!);
      const report = errors.get(id);
      if (!report) throw new HttpError(404, 'No such error report');
      if (m[2] === 'seen') {
        errors.dismiss(id);
        return send(res, 204);
      }
      // Only the file of a report of this run is ever shown: the path never comes from the request.
      const problem = (deps.reveal ?? revealFile)(report.file);
      if (problem) throw new HttpError(500, problem);
      return send(res, 204);
    }

    if (path === '/api/usage') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, deps.usage.summary());
    }

    if (path === '/api/meta') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const { config } = loadConfig();
      const meta: Meta = { profiles: manager.profiles(), models: config.models, saved: config.profiles.map((p) => p.id) };
      return send(res, 200, meta);
    }

    if (path === '/api/lan' || path === '/api/lan/new-link') {
      const lan = deps.lan;
      if (!lan) throw new HttpError(404, 'Not found');
      // Switching off, or a new link, cuts the phones' connections: asked from a phone, the
      // answer goes out first and the change follows. Asked here, the answer says how it went.
      const thenAnswer = async (change: () => void | Promise<void>): Promise<void> => {
        if (gate.local) {
          await change();
          return send(res, 200, lan.info());
        }
        send(res, 204);
        setTimeout(() => {
          Promise.resolve()
            .then(change)
            .catch((e: unknown) => deps.errors?.report({ source: 'server', error: e, context: `${method} ${path} from a phone` }));
        }, 50);
      };
      if (path === '/api/lan/new-link') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        return thenAnswer(() => lan.newLink());
      }
      if (method === 'GET') return send(res, 200, lan.info());
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      const b = await readObject(req);
      if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'Say whether phone access is on: {"enabled": true} or {"enabled": false}');
      assertConfigWritable();
      if (b.enabled) {
        try {
          await lan.start();
        } catch (e) {
          throw new HttpError(409, `Phone access could not start: ${(e as Error).message}`);
        }
      }
      // Kept, so that phone access is as the user left it after a restart.
      const { config } = loadConfig();
      config.lan = { ...config.lan, enabled: b.enabled };
      saveConfig(config);
      if (b.enabled) return send(res, 200, lan.info());
      return thenAnswer(() => lan.stop());
    }

    if (path === '/api/profiles') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      if (!Array.isArray(body)) throw new HttpError(400, 'Body must be a list of profiles');
      assertConfigWritable();
      const { config } = loadConfig();
      config.profiles = normalizeProfiles(body);
      saveConfig(config);
      return send(res, 200, config.profiles);
    }

    if (path === '/api/shutdown') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      send(res, 204);
      deps.onShutdown();
      return;
    }

    throw new HttpError(404, 'Not found');
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof ConfigInvalidError) send(res, 409, { error: e.message });
      else if (e instanceof HttpError) send(res, e.status, { error: e.message }, e.status === 413 ? { connection: 'close' } : {});
      else {
        // Unexpected: written to a report, whose path the page is told about.
        const path = (req.url ?? '/').split('?')[0];
        const report = deps.errors?.report({ source: 'server', error: e, context: `${req.method ?? 'GET'} ${path}` });
        send(res, 500, { error: report ? `Internal error. Details in ${report.file}` : 'Internal error' });
      }
    });
  };
}
