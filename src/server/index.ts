import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPageHost, newToken } from './auth.js';
import { ActivityMeter } from './activity.js';
import { RuleStore } from './area-rules.js';
import { RecipeStore } from './recipes.js';
import { StatusLog } from './status-log.js';
import { ClosedStore } from './closed.js';
import { clearServerState, dataDir, loadConfig, logPath, readServerState, writeServerState } from './config.js';
import { openInEditor } from './editor.js';
import { createRequestHandler, type HttpDeps } from './http.js';
import { LanAccess, lanGate } from './lan.js';
import { listenOnFirstFree } from './listen.js';
import { realPtyFactory, type PtyFactory } from './pty-session.js';
import { claudeProjectsDir, findConversation } from './conversations.js';
import { TranscriptScanner } from './transcript-usage.js';
import { PromptDelivery } from './prompt-delivery.js';
import { loadRestorable, restoreSessions, saveRestorable } from './restore.js';
import { launcherFingerprint, ScheduleStore, type LaunchResult } from './schedules.js';
import { SessionManager } from './session-manager.js';
import { SoundStore } from './sounds.js';
import { StoryStore } from './stories.js';
import { UsageStore } from './usage.js';
import type { Schedule } from '../shared/types.js';
import { attachWebSocket } from './ws.js';
import { ErrorReporter, errorsDir } from './errors.js';
import { ChangeTracker, changesOf } from './changes.js';

export const DEFAULT_PORT = 7717;

/** The version of the package this file belongs to (from dist/server or src/server alike). */
export function packageVersion(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}
const HOST = '127.0.0.1';
/** How much transcript is read in one go; small enough not to be felt while typing. */
const SCAN_STEP_BYTES = 4 * 1024 * 1024;
const SCAN_BUSY_MS = 100;
const SCAN_IDLE_MS = 3000;

export interface RunningServer {
  port: number;
  /** The host name the page is served on in this start. */
  pageHost: string;
  token: string;
  address: string;
  /** Writes reports for unexpected errors of this run; the page is told about each. */
  errors: ErrorReporter;
  stop(): Promise<void>;
  /** Resolves once the server has stopped, however that was triggered. */
  stopped: Promise<void>;
}

export interface StartOptions {
  port?: number;
  ptyFactory?: PtyFactory;
  quiet?: boolean;
  /** Stands in for starting VS Code, in tests. */
  openEditor?: typeof openInEditor;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(`${new Date().toISOString()} ${msg}`);
  };

  const first = loadConfig({ quarantineCorrupt: true });
  if (first.warning) log(`warning: ${first.warning}`);

  const server = createServer();
  const port = await listenOnFirstFree(server, opts.port ?? DEFAULT_PORT, HOST);
  const token = newToken();
  const hookToken = newToken();
  // A new host name for the page at every start: see newPageHost.
  const pageHost = newPageHost();
  const startedAt = Date.now();
  const here = dirname(fileURLToPath(import.meta.url));
  // Phone access: an HTTPS listener of its own on the local network, started only while
  // switched on; LanAccess gives it its certificate.
  const lanServer = createHttpsServer();
  const lan = new LanAccess({ server: lanServer, preferredPort: () => loadConfig().config.lan.port });
  const errors = new ErrorReporter({
    dir: errorsDir(dataDir()),
    now: Date.now,
    version: packageVersion(),
    // The page's host name is a secret too: whoever knows it can serve a page there.
    secrets: () => [token, hookToken, pageHost.split('.')[0]!, ...(lan.knownToken() ? [lan.knownToken()!] : [])],
    logTail: () => readLogTail(40),
  });
  activeReporter = errors;

  const stories = new StoryStore();
  stories.ensureColors();
  const sounds = new SoundStore(stories);
  const manager = new SessionManager({
    stories: () => stories.list(),
    ptyFactory: opts.ptyFactory ?? realPtyFactory,
    now: Date.now,
    // Read on every use so edits to config.json apply without a restart.
    config: () => loadConfig().config,
    port,
    hookToken,
    hookScriptPath: join(here, '..', 'hook', 'hook.js'),
    statusScriptPath: join(here, '..', 'hook', 'statusline.js'),
  });
  const usage = new UsageStore({ now: Date.now, file: join(dataDir(), 'usage.json') });
  const activity = new ActivityMeter(Date.now);
  manager.onOutput((id, data) => activity.add(id, data.length));
  // Sessions that end or are closed are remembered, to be opened again from their area.
  const closed = new ClosedStore({ file: join(dataDir(), 'closed.json'), now: Date.now });
  const rules = new RuleStore({ file: join(dataDir(), 'rules.json'), now: Date.now });
  const recipes = new RecipeStore({ file: join(dataDir(), 'recipes.json') });
  const flow = new StatusLog({ now: Date.now, file: join(dataDir(), 'flow.json') });
  manager.onChange((sessions) => flow.observe(sessions));
  manager.onClosed((entry, sessionId) => closed.add(entry, sessionId));
  // The uncommitted changes of the worktrees sessions work in, for the badges on the page.
  const changes = new ChangeTracker({ read: (worktree) => changesOf(worktree) });
  const trackWorktrees = (): void =>
    changes.track(
      manager
        .list()
        .filter((s) => s.status !== 'exited' && s.git)
        .map((s) => s.git!.worktree),
    );
  manager.onChange(trackWorktrees);

  // Schedules: at its time, a schedule opens a Claude Code session like any other, and its
  // prompt is typed into the terminal once Claude Code is ready for it.
  const delivery = new PromptDelivery({
    now: Date.now,
    write: (id, data) => manager.input(id, data),
    alive: (id) => {
      const s = manager.get(id);
      return s !== null && s.status !== 'exited';
    },
  });
  const launchSchedule = (schedule: Schedule): LaunchResult => {
    const profile = manager.profiles().find((p) => p.id === schedule.profileId);
    if (!profile) return { error: 'The launcher of this schedule no longer exists.' };
    if (profile.kind !== 'claude') return { error: `The launcher "${profile.name}" does not start Claude Code.` };
    const storyId = schedule.storyId !== null && stories.list().some((s) => s.id === schedule.storyId) ? schedule.storyId : null;
    const session = manager.create({
      profileId: profile.id,
      name: schedule.name,
      storyId,
      ...(schedule.cwd ? { cwd: schedule.cwd } : {}),
      ...(schedule.model ? { model: schedule.model } : {}),
      args: [...profile.args, ...(schedule.permissionMode === 'default' ? [] : ['--permission-mode', schedule.permissionMode])],
    });
    if (session.error) {
      // Nobody is watching: a session that never started is recorded in the run, not left open.
      manager.remove(session.id);
      return { error: session.error };
    }
    delivery.expect(session.id, schedule.prompt, (outcome, detail) => schedules.resolveRun(schedule.id, session.id, outcome, detail));
    log(`schedule "${schedule.name}": started session ${session.id}`);
    return { sessionId: session.id };
  };
  const schedules: ScheduleStore = new ScheduleStore({
    file: join(dataDir(), 'schedules.json'),
    now: Date.now,
    launch: launchSchedule,
    fingerprint: (profileId) => {
      const profile = manager.profiles().find((p) => p.id === profileId);
      return profile ? launcherFingerprint(profile) : null;
    },
    busy: (id) => {
      const s = manager.get(id);
      return s !== null && (s.status === 'working' || (s.status === 'attention' && s.reason === 'blocked'));
    },
  });
  schedules.start();
  // How each run goes: when it waits on the user, when it finishes.
  manager.onChange((sessions) => schedules.observe(sessions));
  const deliveryTicker = setInterval(() => delivery.tick(), 200);
  deliveryTicker.unref?.();

  // Sessions open at the last stop come back; from then on the list is kept current, so that
  // it is right even if the server is killed. An orderly stop must not empty it: stopping
  // ends every process, which is not the user closing their sessions.
  const sessionsFile = join(dataDir(), 'sessions.json');
  if (first.config.restoreSessions) {
    const previous = loadRestorable(sessionsFile);
    if (previous.length > 0) {
      log(`restoring ${previous.length} session(s) from the last run`);
      restoreSessions(manager, previous, findConversation);
    }
  }
  // Costs are read from Claude Code's transcripts, a little at a time so that terminals are
  // never held up: quickly while there is a backlog (the first start reads a month of them),
  // then at an idle pace.
  const scanner = new TranscriptScanner({
    dir: claudeProjectsDir,
    usage,
    now: Date.now,
    storyOf: (conversationId) => {
      const sessionId = manager.openConversations().get(conversationId);
      const storyId = sessionId ? manager.get(sessionId)?.storyId : null;
      const story = storyId ? stories.list().find((s) => s.id === storyId) : undefined;
      return { storyId: story?.id ?? null, storyName: story?.name ?? null };
    },
  });
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanning = true;
  const scanLoop = async (): Promise<void> => {
    if (!scanning) return;
    let more = false;
    try {
      more = await scanner.tick(SCAN_STEP_BYTES);
    } catch (e) {
      log(`usage: could not read transcripts: ${(e as Error).message}`);
    }
    if (!scanning) return;
    scanTimer = setTimeout(() => void scanLoop(), more ? SCAN_BUSY_MS : SCAN_IDLE_MS);
    scanTimer.unref?.();
  };
  scanTimer = setTimeout(() => void scanLoop(), 300);
  scanTimer.unref?.();

  let saving = true;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = (): void => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (saving) saveRestorable(sessionsFile, manager.restorable());
  };
  manager.onChange(() => {
    if (!saving || saveTimer) return;
    saveTimer = setTimeout(saveNow, 200);
    saveTimer.unref?.();
  });
  saveNow();

  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((r) => (resolveStopped = r));
  let stopping: Promise<void> | null = null;

  const wsDeps = { manager, stories, rules, closed, schedules, usage, activity, errors, changes, lan, port, pageHost, token };
  const ws = attachWebSocket(server, wsDeps);
  const lanWs = attachWebSocket(lanServer, { ...wsDeps, gate: lanGate(lan), onClients: () => lan.changed() });
  lan.attachSockets(lanWs);
  const ticker = setInterval(() => {
    manager.tick();
    schedules.tick();
  }, 1000);
  // A branch switched or a commit made inside a terminal shows up without a git process.
  const headTicker = setInterval(() => manager.refreshHeads(), 10_000);
  // Changes made outside Claude's tools (an editor, a shell) show up within this time.
  const changesTicker = setInterval(() => void changes.refreshAll(), 15_000);
  changesTicker.unref?.();
  // The day totals of the flow are written now and then, and on stopping.
  const flowTicker = setInterval(() => flow.persist(), 60_000);
  flowTicker.unref?.();

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(ticker);
      clearInterval(headTicker);
      clearInterval(changesTicker);
      changes.stop();
      clearInterval(flowTicker);
      clearInterval(deliveryTicker);
      scanning = false;
      clearTimeout(scanTimer);
      saveNow();
      saving = false;
      manager.shutdown();
      schedules.flush();
      usage.flush();
      flow.observe([]);
      flow.persist();
      // An orderly stop, not the user switching it off: config.json keeps it as it was.
      await lan.stop().catch((e: unknown) => log(`phone access: could not stop: ${(e as Error).message}`));
      lanWs.close();
      ws.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      // Another server may have taken over the state file since; only remove our own.
      const recorded = readServerState();
      if (recorded && recorded.pid === process.pid && recorded.startedAt === startedAt) clearServerState();
      log('stopped');
      errors.dispose();
      if (activeReporter === errors) activeReporter = null;
      resolveStopped();
    })();
    return stopping;
  };

  const httpDeps: HttpDeps = {
      manager,
      stories,
      sounds,
      usage,
      closed,
      schedules,
      rules,
      recipes,
      flow,
      // The outcome is visible in the session itself; nothing waits on it here.
      deliverPrompt: (id, prompt) => delivery.expect(id, prompt, () => undefined),
      openEditor: opts.openEditor ?? openInEditor,
      onClaudeStatus: (id) => delivery.ready(id),
      onPromptSubmitted: (id) => delivery.submitted(id),
      errors,
      // After Claude uses a tool or ends a turn, its worktree is read again.
      onHook: (id, name) => {
        if (name !== 'PostToolUse' && name !== 'Stop') return;
        const worktree = manager.get(id)?.git?.worktree;
        if (worktree) changes.soon(worktree);
      },
      changes,
      lan,
      port,
      pageHost,
      token,
      hookToken,
      webDir: join(here, '..', 'web'),
      version: packageVersion(),
      // Let the 204 reach the caller before the sockets are torn down.
      onShutdown: () => void setTimeout(() => void stop(), 50),
  };
  server.on('request', createRequestHandler(httpDeps));
  lanServer.on('request', createRequestHandler({ ...httpDeps, gate: lanGate(lan) }));

  writeServerState({ pid: process.pid, port, pageHost, token, hookToken, startedAt });
  log(`listening on http://${HOST}:${port}, page on http://${pageHost}:${port}`);
  // Left on at the last stop: on again. Not being able to is said in the log, never fatal.
  if (first.config.lan.enabled) {
    try {
      await lan.start();
      log(`phone access on port ${lan.port()} (${lan.status().addresses.map((a) => a.ip).join(', ') || 'no local network address yet'})`);
    } catch (e) {
      log(`phone access: could not start: ${(e as Error).message}`);
    }
  }
  lan.onChange((s) => log(s.enabled ? `phone access: on, port ${s.port}, ${s.clients} connected` : 'phone access: off'));

  return { port, pageHost, token, address: (server.address() as AddressInfo).address, errors, stop, stopped };
}

/** The reporter of the server running in this process, for errors no request or task catches. */
let activeReporter: ErrorReporter | null = null;
/**
 * The reporter used when no server runs in this process. One for the whole process, made when
 * first needed, so that a repeated error is counted and the rate limit holds here as well.
 */
let fallbackReporter: { dir: string; reporter: ErrorReporter } | null = null;

function fallback(): ErrorReporter {
  const dir = errorsDir(dataDir());
  if (fallbackReporter?.dir !== dir) {
    fallbackReporter = { dir, reporter: new ErrorReporter({ dir, now: Date.now, version: packageVersion(), logTail: () => readLogTail(40) }) };
  }
  return fallbackReporter.reporter;
}

function readLogTail(lines: number): string {
  try {
    return readFileSync(logPath(), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Writes a report for an error nothing else caught, and logs where it is. Before the server is up
 * (or after it stopped) the report is written without the secrets of a run, as there are none.
 */
export function reportUncaught(source: 'server' | 'startup', e: unknown, context: string): string | null {
  let reporter = activeReporter;
  try {
    reporter ??= fallback();
    return reporter.report({ source, error: e, context })?.file ?? null;
  } catch {
    return null;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : undefined;
  // One failing session must not take the others down with it.
  // Each is written to a report of its own as well, and the page shows where.
  process.on('uncaughtException', (e) => {
    const file = reportUncaught('server', e, 'uncaught exception');
    console.error(`${new Date().toISOString()} uncaught: ${e.stack ?? e}${file ? `\n  report: ${file}` : ''}`);
  });
  process.on('unhandledRejection', (e) => {
    const file = reportUncaught('server', e, 'unhandled promise rejection');
    console.error(`${new Date().toISOString()} unhandled: ${String(e)}${file ? `\n  report: ${file}` : ''}`);
  });
  startServer({ port: Number.isInteger(port) ? port : undefined })
    .then((running) => {
      const shutdown = (): void => void running.stop();
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      void running.stopped.then(() => process.exit(0));
    })
    .catch((e: unknown) => {
      const file = reportUncaught('startup', e, 'starting the server');
      console.error(`${new Date().toISOString()} failed to start: ${(e as Error).stack ?? e}${file ? `\n  report: ${file}` : ''}`);
      process.exit(1);
    });
}
