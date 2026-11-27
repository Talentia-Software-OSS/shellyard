import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthProof, newChallenge } from '../../src/server/auth.js';
import { loadConfig } from '../../src/server/config.js';
import { headOf, samePath } from '../../src/server/git.js';
import { createRequestHandler } from '../../src/server/http.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { StoryStore } from '../../src/server/stories.js';
import { ClosedStore } from '../../src/server/closed.js';
import { RuleStore } from '../../src/server/area-rules.js';
import { RecipeStore } from '../../src/server/recipes.js';
import { StatusLog } from '../../src/server/status-log.js';
import { UsageStore } from '../../src/server/usage.js';
import { ErrorReporter } from '../../src/server/errors.js';
import type { Profile, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, removeDir, useTempHome } from '../helpers.js';

const TOKEN = 't'.repeat(64);
const HOOK_TOKEN = 'h'.repeat(64);
const PAGE = 'c'.repeat(32) + '.localhost';
const builtin: Profile = { id: 'builtin-node', name: 'Node', kind: 'shell', command: process.execPath, args: [], cwd: '', color: '#123456', env: {}, model: null };

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => any;
}

type CallOpts = { body?: string; headers?: Record<string, string>; auth?: 'user' | 'none' | 'hook' };

/** Raw request so the Host header and the path can be anything. */
function callAt(port: number, method: string, path: string, opts: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { host: `${PAGE}:${port}`, ...opts.headers };
  const auth = opts.auth ?? 'user';
  if (auth === 'user') headers['x-shellyard-token'] = TOKEN;
  if (auth === 'hook') headers['x-shellyard-hook-token'] = HOOK_TOKEN;
  if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('http api', () => {
  const home = useTempHome();
  let server: Server;
  let port = 0;
  let mgr: SessionManager;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let shutdowns = 0;
  let webDir = '';
  let stories: StoryStore;
  let rules: RuleStore;

  const call = (method: string, path: string, opts: CallOpts = {}): Promise<Res> => callAt(port, method, path, opts);

  beforeEach(async () => {
    shutdowns = 0;
    ptys = fakePtyFactory();
    webDir = join(home.dir(), 'web');
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<html>ShellYard APP</html>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(home.dir(), 'secret.txt'), 'TOP SECRET');
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    stories = new StoryStore();
    mgr = new SessionManager({
      stories: () => stories.list(),
      ptyFactory: ptys.factory,
      now: Date.now,
      config: () => loadConfig().config,
      port,
      hookToken: HOOK_TOKEN,
      hookScriptPath: '/h.js', statusScriptPath: '/s.js',
      builtins: () => [builtin],
      gitOf: async () => null,
      headOf: () => null,
    });
    rules = new RuleStore({ now: Date.now, file: join(home.dir(), 'rules.json') });
    server.on('request', createRequestHandler({ manager: mgr, stories, rules, flow: new StatusLog({ now: Date.now }), usage: new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') }), closed: new ClosedStore({ now: Date.now, file: join(home.dir(), 'closed.json') }), port, pageHost: PAGE, token: TOKEN, hookToken: HOOK_TOKEN, webDir, onShutdown: () => shutdowns++ }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  /** A permission request, then the notification that its menu is on screen; the status of the first. */
  const ask = async (id: string, body: string): Promise<number> => {
    const status = (await call('POST', `/api/hooks/${id}`, { auth: 'hook', body })).status;
    if (status === 204) await call('POST', `/api/hooks/${id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }) });
    return status;
  };

  const newSession = async (kind: 'shell' | 'claude' = 'shell') =>
    (await call('POST', '/api/sessions', { body: JSON.stringify({ kind, command: process.execPath, cwd: home.dir() }) })).json();

  describe('gatekeeping', () => {
    it('rejects a foreign Host header', async () => {
      const r = await call('GET', '/api/health', { headers: { host: 'evil.com' } });
      expect(r.status).toBe(403);
    });

    it('answers health without credentials, saying nothing that identifies this server', async () => {
      const r = await call('GET', '/api/health', { auth: 'none' });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({ ok: true, app: 'shellyard' });
    });

    it('answers a health challenge with a proof that it holds the token', async () => {
      const challenge = newChallenge();
      const r = await call('GET', `/api/health?challenge=${challenge}`, { auth: 'none' });
      expect(r.json()).toEqual({ ok: true, app: 'shellyard', proof: healthProof(TOKEN, challenge) });
      // A malformed challenge gets no proof at all.
      expect((await call('GET', '/api/health?challenge=xyz', { auth: 'none' })).json()).toEqual({ ok: true, app: 'shellyard' });
    });

    it('refuses the api without credentials', async () => {
      expect((await call('GET', '/api/sessions', { auth: 'none' })).status).toBe(401);
      expect((await call('POST', '/api/sessions', { auth: 'none', body: '{}' })).status).toBe(401);
      expect((await call('POST', '/api/shutdown', { auth: 'none' })).status).toBe(401);
      expect(shutdowns).toBe(0);
    });

    it('serves the app itself without credentials: it holds no secret, the api does', async () => {
      const page = await call('GET', '/', { auth: 'none' });
      expect(page.status).toBe(200);
      expect(page.text).toContain('ShellYard APP');
      expect((await call('GET', '/assets/app.js', { auth: 'none' })).status).toBe(200);
    });

    it('does not accept the hook token as a user token', async () => {
      const r = await call('GET', '/api/sessions', { auth: 'none', headers: { 'x-shellyard-token': HOOK_TOKEN } });
      expect(r.status).toBe(401);
    });

    it('never sets a cookie, whatever the request', async () => {
      // A cookie for 127.0.0.1 would be sent by the browser to every other port on this machine.
      for (const r of [
        await call('GET', `/?token=${TOKEN}`, { auth: 'none' }),
        await call('GET', '/'),
        await call('GET', '/api/sessions'),
        await call('GET', '/api/health', { auth: 'none' }),
      ]) {
        expect(r.headers['set-cookie']).toBeUndefined();
        expect(r.headers.location).toBeUndefined();
      }
    });

    it('grants no cross-origin access: a preflight gets no permission headers', async () => {
      // This is what stops another site from sending the token header at all.
      const r = await call('OPTIONS', '/api/sessions', {
        auth: 'none',
        headers: { origin: 'http://evil.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-shellyard-token' },
      });
      expect(r.status).toBe(401);
      for (const name of Object.keys(r.headers)) expect(name.startsWith('access-control-')).toBe(false);
    });

    it('does not accept a cookie as a credential', async () => {
      const r = await call('GET', '/api/sessions', { auth: 'none', headers: { cookie: `shellyard_auth=${TOKEN}` } });
      expect(r.status).toBe(401);
    });

    it('refuses a state-changing request that names another origin, even with the token', async () => {
      const body = JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir() });
      const r = await call('POST', '/api/sessions', { body, headers: { origin: 'http://127.0.0.1:3000' } });
      expect(r.status).toBe(403);
      expect(mgr.list()).toEqual([]);
      expect((await call('POST', '/api/shutdown', { headers: { origin: 'http://evil.com' } })).status).toBe(403);
      expect(shutdowns).toBe(0);
    });

    it('accepts a state-changing request from its own origin', async () => {
      const body = JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir() });
      const r = await call('POST', '/api/sessions', { body, headers: { origin: `http://${PAGE}:${port}` } });
      expect(r.status).toBe(201);
    });

    it('rejects an oversized body', async () => {
      const r = await call('POST', '/api/sessions', { body: 'x'.repeat(2 * 1024 * 1024) }).catch(() => ({ status: 413 }) as Res);
      expect(r.status).toBe(413);
      expect(mgr.list()).toEqual([]);
    });
  });

  describe('sessions', () => {
    it('creates, lists, updates, acknowledges and deletes', async () => {
      const created = await call('POST', '/api/sessions', { body: JSON.stringify({ profileId: 'builtin-node', cwd: home.dir(), name: 'one' }) });
      expect(created.status).toBe(201);
      const s = created.json();
      expect(s).toMatchObject({ name: 'one', status: 'running', color: '#123456' });

      expect((await call('GET', '/api/sessions')).json()).toHaveLength(1);

      const patched = await call('PATCH', `/api/sessions/${s.id}`, { body: JSON.stringify({ name: 'two' }) });
      expect(patched.json().name).toBe('two');

      const c = await newSession('claude');
      mgr.hook(c.id, 'Stop', false);
      const acked = await call('POST', `/api/sessions/${c.id}/ack`);
      expect(acked.json()).toMatchObject({ status: 'idle' });

      expect((await call('DELETE', `/api/sessions/${s.id}`)).status).toBe(204);
      expect(mgr.get(s.id)).toBeNull();
    });

    it('answers 404 for unknown sessions', async () => {
      expect((await call('PATCH', '/api/sessions/nope', { body: '{}' })).status).toBe(404);
      expect((await call('POST', '/api/sessions/nope/ack')).status).toBe(404);
      expect((await call('DELETE', '/api/sessions/nope')).status).toBe(404);
    });

    it('answers 400 for a body that is not a JSON object', async () => {
      expect((await call('POST', '/api/sessions', { body: '{oops' })).status).toBe(400);
      expect((await call('POST', '/api/sessions', { body: '[1,2]' })).status).toBe(400);
      expect(mgr.list()).toEqual([]);
    });

    it('ignores fields of the wrong type instead of crashing', async () => {
      const r = await call('POST', '/api/sessions', { body: JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir(), args: 'not-an-array', name: 42 }) });
      expect(r.status).toBe(201);
      expect(r.json().args).toEqual([]);
    });

    it('answers 404 for an unknown api route and 405 for a wrong method', async () => {
      expect((await call('GET', '/api/nope')).status).toBe(404);
      expect((await call('PUT', '/api/sessions')).status).toBe(405);
    });
  });

  describe('meta and profiles', () => {
    it('lists saved profiles first, then built-ins not overridden, with the models', async () => {
      const mine: Profile = { ...builtin, id: 'mine', name: 'Mine' };
      const override: Profile = { ...builtin, name: 'Node (mine)' };
      const saved = await call('PUT', '/api/profiles', { body: JSON.stringify([mine, override]) });
      expect(saved.status).toBe(200);
      const meta = (await call('GET', '/api/meta')).json();
      expect(meta.profiles.map((p: Profile) => p.name)).toEqual(['Mine', 'Node (mine)']);
      expect(meta.models).toEqual(['opus', 'sonnet', 'haiku']);
      expect(loadConfig().config.profiles).toHaveLength(2);
    });

    it('keeps a built-in profile in its place when its settings are changed, and says which are saved', async () => {
      const custom: Profile = { ...builtin, id: 'mine', name: 'Mine' };
      const override: Profile = { ...builtin, cwd: home.dir() };
      await call('PUT', '/api/profiles', { body: JSON.stringify([custom, override]) });
      const meta = (await call('GET', '/api/meta')).json();
      expect(meta.profiles.find((p: Profile) => p.id === 'builtin-node').cwd).toBe(home.dir());
      expect(meta.saved.sort()).toEqual(['builtin-node', 'mine']);
      // Removing the override brings the built-in default back.
      await call('PUT', '/api/profiles', { body: JSON.stringify([custom]) });
      const after = (await call('GET', '/api/meta')).json();
      expect(after.profiles.find((p: Profile) => p.id === 'builtin-node').cwd).toBe('');
      expect(after.saved).toEqual(['mine']);
    });

    it('starts a session from a profile in the folder saved for it', async () => {
      const work = join(home.dir(), 'work');
      mkdirSync(work);
      await call('PUT', '/api/profiles', { body: JSON.stringify([{ ...builtin, cwd: work }]) });
      const s = (await call('POST', '/api/sessions', { body: JSON.stringify({ profileId: 'builtin-node' }) })).json();
      expect(s).toMatchObject({ cwd: work, status: 'running' });
    });

    it('rejects profiles that are not a list', async () => {
      expect((await call('PUT', '/api/profiles', { body: '{"a":1}' })).status).toBe(400);
    });
  });

  describe('orders', () => {
    for (const path of ['/api/stories/order', '/api/sessions/order', '/api/profiles/order']) {
      it(`${path} needs the token and a list of strings`, async () => {
        expect((await call('PUT', path, { auth: 'none', body: '[]' })).status).toBe(401);
        expect((await call('PUT', path, { body: '{}' })).status).toBe(400);
        expect((await call('PUT', path, { body: '["a", 1]' })).status).toBe(400);
        expect((await call('PUT', path, { body: '[]' })).status).toBe(200);
      });
    }

    it('reorders areas, sessions and launchers', async () => {
      const a = (await call('POST', '/api/stories', { body: JSON.stringify({ name: 'A' }) })).json();
      const b = (await call('POST', '/api/stories', { body: JSON.stringify({ name: 'B' }) })).json();
      const r1 = await call('PUT', '/api/stories/order', { body: JSON.stringify([b.id, a.id]) });
      expect(r1.json().map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
      const s1 = await newSession();
      const s2 = await newSession();
      const r2 = await call('PUT', '/api/sessions/order', { body: JSON.stringify([s2.id, s1.id]) });
      expect(r2.json().map((s: { id: string }) => s.id)).toEqual([s2.id, s1.id]);
      const r3 = await call('PUT', '/api/profiles/order', { body: JSON.stringify(['builtin-node']) });
      expect(r3.json().map((p: { id: string }) => p.id)).toEqual(['builtin-node']);
      expect(loadConfig().config.profileOrder).toEqual(['builtin-node']);
    });
  });

  describe('hooks', () => {
    it('applies a hook event', async () => {
      const c = await newSession('claude');
      const r = await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }) });
      expect(r.status).toBe(204);
      expect(mgr.get(c.id)!.status).toBe('working');
    });

    it('passes the idle-reminder flag through', async () => {
      const c = await newSession('claude');
      await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }) });
      expect(mgr.get(c.id)!.status).toBe('idle');
      await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }) });
      expect(mgr.get(c.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
    });

    it('records what a permission request asks, and lets the user answer it once', async () => {
      const c = await newSession('claude');
      const hook = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'dotnet test' } };
      expect(await ask(c.id, JSON.stringify(hook))).toBe(204);
      const pending = mgr.get(c.id)!.pending!;
      expect(pending).toMatchObject({ kind: 'permission', tool: 'Bash', detail: 'dotnet test' });

      const answer = (body: unknown, id = c.id) => call('POST', `/api/sessions/${id}/answer`, { body: JSON.stringify(body) });
      expect((await answer({ requestId: pending.id, choice: 'always' })).status).toBe(400);
      expect((await answer({ choice: 'once' })).status).toBe(400);
      expect((await answer({ requestId: pending.id, choice: 'once' }, 'nope')).status).toBe(404);
      expect((await answer({ requestId: 'other', choice: 'once' })).status).toBe(409);
      expect(ptys.last().written).toEqual([]);

      const ok = await answer({ requestId: pending.id, choice: 'once' });
      expect(ok.status).toBe(200);
      expect((await ok.json()).pending).toBeNull();
      expect(ptys.last().written).toEqual(['\r']);
      expect((await answer({ requestId: pending.id, choice: 'deny' })).status).toBe(409);
      expect((await call('GET', `/api/sessions/${c.id}/answer`)).status).toBe(405);
    });
  });

  describe('flow', () => {
    it('gives how the day went to the user token only', async () => {
      expect((await call('GET', '/api/flow', { auth: 'none' })).status).toBe(401);
      const r = await call('GET', '/api/flow');
      expect(r.status).toBe(200);
      expect(r.json()).toMatchObject({ today: { blockedMs: 0, answers: 0 }, previous: null, timeline: { sessions: [] } });
      expect((await call('POST', '/api/flow')).status).toBe(405);
    });
  });

  describe('one prompt to several sessions', () => {
    const send = (body: unknown) => call('POST', '/api/sessions/prompt', { body: JSON.stringify(body) });

    it('types it into the sessions at their prompt and says which did not take it', async () => {
      const a = await newSession('claude');
      const b = await newSession('claude');
      const fresh = await newSession('claude');
      mgr.noteStatusLine(a.id);
      mgr.noteStatusLine(b.id);
      mgr.hook(b.id, 'UserPromptSubmit', false);
      const sh = await newSession('shell');
      const r = await send({ ids: [a.id, b.id, fresh.id, sh.id, 'gone', a.id], prompt: 'run the tests' });
      expect(r.status).toBe(200);
      expect((await r.json()).results).toEqual([
        { id: a.id, outcome: 'sent' },
        { id: b.id, outcome: 'busy' },
        { id: fresh.id, outcome: 'starting' },
        { id: sh.id, outcome: 'not-claude' },
        { id: 'gone', outcome: 'missing' },
      ]);
      expect(ptys.ptys.find((p) => p.written.length > 0)?.written[0]).toBe('\x1b[200~run the tests\x1b[201~');
    });

    it('refuses an empty prompt, no sessions, too many, and the wrong method', async () => {
      const a = await newSession('claude');
      expect((await send({ ids: [a.id], prompt: '   ' })).status).toBe(400);
      expect((await send({ ids: [], prompt: 'x' })).status).toBe(400);
      expect((await send({ ids: Array.from({ length: 51 }, (_, i) => `s${i}`), prompt: 'x' })).status).toBe(400);
      expect((await send({ ids: [a.id], prompt: 'x'.repeat(20_001) })).status).toBe(400);
      expect((await call('GET', '/api/sessions/prompt')).status).toBe(405);
      expect(ptys.last().written).toEqual([]);
    });
  });

  describe('area rules', () => {
    const permission = (command: string, tool = 'Bash') => JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: { command } });
    const inArea = async () => {
      const story = await (await call('POST', '/api/stories', { body: JSON.stringify({ name: 'Payroll' }) })).json();
      const s = await (await call('POST', '/api/sessions', { body: JSON.stringify({ kind: 'claude', command: process.execPath, cwd: home.dir(), storyId: story.id }) })).json();
      return { story, s };
    };
    const answer = (id: string, requestId: string, choice: string) => call('POST', `/api/sessions/${id}/answer`, { body: JSON.stringify({ requestId, choice }) });

    it('allows a command a rule of its area covers, without stopping the session', async () => {
      const { story, s } = await inArea();
      expect((await call('POST', `/api/stories/${story.id}/rules`, { body: JSON.stringify({ pattern: 'dotnet test *' }) })).status).toBe(201);
      const r = await call('POST', `/api/hooks/${s.id}`, { auth: 'hook', body: permission('dotnet test src/X') });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
      expect(mgr.get(s.id)).toMatchObject({ status: 'idle', pending: null });
      expect(rules.list()[0]!.weekHits).toBe(1);
    });

    it('asks as usual for what no rule covers: another command, a chained one, another tool, another area', async () => {
      const { story, s } = await inArea();
      const other = await inArea();
      rules.create(story.id, 'dotnet test *');
      for (const [id, body] of [
        [s.id, permission('dotnet build')],
        [s.id, permission('dotnet test && curl evil')],
        [s.id, permission('dotnet test', 'Edit')],
        [other.s.id, permission('dotnet test')],
      ] as const) {
        expect(await ask(id, body)).toBe(204);
        expect(mgr.get(id)).toMatchObject({ status: 'attention', reason: 'blocked' });
        mgr.input(id, '\x1b');
      }
      expect(rules.list()[0]!.weekHits).toBe(0);
    });

    it('"always in this area" adds the rule made from the command, and allows it once', async () => {
      const { story, s } = await inArea();
      await ask(s.id, permission('dotnet test src/Demo.Payroll.Tests --filter Slot'));
      const r = await answer(s.id, mgr.get(s.id)!.pending!.id, 'area');
      expect(r.status).toBe(200);
      expect(ptys.last().written).toEqual(['\r']);
      expect(rules.list()).toEqual([expect.objectContaining({ storyId: story.id, pattern: 'dotnet test *', enabled: true })]);
    });

    it('refuses "always in this area" for what cannot become a rule, typing nothing', async () => {
      const { s } = await inArea();
      await ask(s.id, permission('dotnet test; rm -rf /'));
      expect((await answer(s.id, mgr.get(s.id)!.pending!.id, 'area')).status).toBe(409);
      mgr.input(s.id, '\x1b');

      await ask(s.id, permission('x', 'Edit'));
      expect((await answer(s.id, mgr.get(s.id)!.pending!.id, 'area')).status).toBe(409);
      mgr.input(s.id, '\x1b');

      // A permission known only from the notification: no command to make a rule from.
      await call('POST', `/api/hooks/${s.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }) });
      const r = await answer(s.id, mgr.get(s.id)!.pending!.id, 'area');
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/did not say which command/);
      mgr.input(s.id, '\x1b');

      const loose = await newSession('claude');
      await ask(loose.id, permission('dotnet test'));
      expect((await answer(loose.id, mgr.get(loose.id)!.pending!.id, 'area')).status).toBe(409);
      expect((await answer(loose.id, 'stale', 'area')).status).toBe(409);
      expect(ptys.last().written).toEqual([]);
      expect(rules.list()).toEqual([]);
    });

    it('creates, switches off, edits and deletes rules, and drops them with their area', async () => {
      const { story } = await inArea();
      expect((await call('POST', `/api/stories/${story.id}/rules`, { body: JSON.stringify({ pattern: 'rm *; x' }) })).status).toBe(400);
      expect((await call('POST', '/api/stories/nope/rules', { body: JSON.stringify({ pattern: 'git status' }) })).status).toBe(404);
      const rule = await (await call('POST', `/api/stories/${story.id}/rules`, { body: JSON.stringify({ pattern: 'git status' }) })).json();
      expect((await (await call('PATCH', `/api/rules/${rule.id}`, { body: JSON.stringify({ enabled: false }) })).json()).enabled).toBe(false);
      expect((await call('PATCH', `/api/rules/${rule.id}`, { body: JSON.stringify({ pattern: 'git $(x)' }) })).status).toBe(400);
      expect((await call('PATCH', '/api/rules/nope', { body: JSON.stringify({ enabled: true }) })).status).toBe(404);
      expect((await call('DELETE', `/api/rules/${rule.id}`)).status).toBe(204);
      expect((await call('DELETE', `/api/rules/${rule.id}`)).status).toBe(404);
      rules.create(story.id, 'git diff *');
      expect((await call('DELETE', `/api/stories/${story.id}`)).status).toBe(204);
      expect(rules.list()).toEqual([]);
    });

    it('takes rule changes from the user token only', async () => {
      const { story } = await inArea();
      expect((await call('POST', `/api/stories/${story.id}/rules`, { auth: 'hook', body: JSON.stringify({ pattern: 'git status' }) })).status).toBe(401);
      expect(rules.list()).toEqual([]);
    });

    it('answers 400 for a malformed body or unknown event, changing nothing', async () => {
      const c = await newSession('claude');
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: '{"hook_event_name":"Sto' })).status).toBe(400);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Nope' }) })).status).toBe(400);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: '' })).status).toBe(400);
      expect(mgr.get(c.id)!.status).toBe('idle');
    });

    it('answers 400, not 500, for a session id that cannot be decoded', async () => {
      const r = await call('POST', '/api/hooks/%E0%A4%A', { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Stop' }) });
      expect(r.status).toBe(400);
      expect((await call('DELETE', '/api/sessions/%E0%A4%A')).status).toBe(400);
    });

    it('answers 404 for an unknown session and for an exited one', async () => {
      const body = JSON.stringify({ hook_event_name: 'Stop' });
      expect((await call('POST', '/api/hooks/nope', { auth: 'hook', body })).status).toBe(404);
      const c = await newSession('claude');
      ptys.last().exit(0);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body })).status).toBe(404);
      expect(mgr.get(c.id)!.status).toBe('exited');
    });

    it('answers 403 without the hook token, even with the user token', async () => {
      const c = await newSession('claude');
      const body = JSON.stringify({ hook_event_name: 'Stop' });
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'user', body })).status).toBe(403);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'none', body })).status).toBe(403);
      expect(mgr.get(c.id)!.status).toBe('idle');
    });
  });

  describe('static files', () => {
    it('serves the app and its assets with a content type', async () => {
      const index = await call('GET', '/');
      expect(index.status).toBe(200);
      expect(index.text).toContain('ShellYard APP');
      expect(String(index.headers['content-type'])).toContain('text/html');
      const js = await call('GET', '/assets/app.js');
      expect(js.text).toBe('console.log(1)');
      expect(String(js.headers['content-type'])).toContain('javascript');
    });

    it('sends a content security policy that allows its own websocket and nothing foreign', async () => {
      const csp = String((await call('GET', '/', { auth: 'none' })).headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain(`connect-src 'self' ws://${PAGE}:${port};`);
      // A sound the user added is fetched with the token and played from a blob: URL.
      expect(csp).toContain("media-src 'self' blob:;");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain('unsafe-eval');
    });

    it('refuses to change anything through a static path', async () => {
      expect((await call('POST', '/', { auth: 'none', body: '{}' })).status).toBe(405);
    });

    it('serves the app only on the page host of this start; 127.0.0.1 only says how to open it', async () => {
      const r = await call('GET', '/', { auth: 'none', headers: { host: `127.0.0.1:${port}` } });
      expect(r.status).toBe(200);
      expect(r.text).not.toContain('ShellYard APP');
      expect(r.text).toContain('shellyard');
      expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
      expect((await call('GET', '/assets/app.js', { auth: 'none', headers: { host: `127.0.0.1:${port}` } })).text).not.toContain('console.log');
    });

    it('tells a tab from an earlier start that the server was restarted, and refuses its api calls', async () => {
      const stale = { host: `${'d'.repeat(32)}.localhost:${port}` };
      const page = await call('GET', '/', { auth: 'none', headers: stale });
      expect(page.text).toMatch(/restarted/);
      expect(page.text).not.toContain('ShellYard APP');
      // Even holding the token, an old page gets the answer that makes it say "run shellyard".
      expect((await call('GET', '/api/sessions', { headers: stale })).status).toBe(401);
    });

    it('still answers the shellyard command on 127.0.0.1', async () => {
      expect((await call('GET', '/api/sessions', { headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
      expect((await call('GET', '/api/sessions', { auth: 'none', headers: { host: `127.0.0.1:${port}` } })).status).toBe(401);
    });

    it('refuses a state-changing request from the 127.0.0.1 origin', async () => {
      const r = await call('POST', '/api/shutdown', { headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } });
      expect(r.status).toBe(403);
      expect(shutdowns).toBe(0);
    });

    it('falls back to the app for an unknown page path, but not for a missing asset', async () => {
      expect((await call('GET', '/some/view')).text).toContain('ShellYard APP');
      expect((await call('GET', '/assets/missing.js')).status).toBe(404);
    });

    it('never serves a file outside the web folder', async () => {
      for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/%2e%2e%5csecret.txt']) {
        const r = await call('GET', path);
        expect(r.text, path).not.toContain('TOP SECRET');
      }
    });
  });

  describe('usage', () => {
    // A limit window that is still open, whenever the test runs.
    const resets5 = Math.floor(Date.now() / 1000) + 3600;
    const status = (cost: number, model = 'Opus') => JSON.stringify({
      model: { id: 'claude-' + model.toLowerCase(), display_name: model },
      cost: { total_cost_usd: cost },
      context_window: { total_input_tokens: 1000, total_output_tokens: 50 },
      rate_limits: { five_hour: { used_percentage: 58, resets_at: resets5 }, seven_day: { used_percentage: 31, resets_at: resets5 + 86400 } },
    });

    it('is empty at first, and needs the token', async () => {
      expect((await call('GET', '/api/usage', { auth: 'none' })).status).toBe(401);
      const u = (await call('GET', '/api/usage')).json();
      expect(u.today).toEqual({ costUsd: 0, byModel: [], byStory: [] });
      expect(u.limits).toEqual({ fiveHour: null, sevenDay: null, readAt: null });
    });

    it('records what a session reports as it goes, under its story, and updates its model', async () => {
      const story = (await call('POST', '/api/stories', { body: JSON.stringify({ name: 'Payroll' }) })).json();
      const c = (await call('POST', '/api/sessions', { body: JSON.stringify({ kind: 'claude', command: process.execPath, cwd: home.dir(), storyId: story.id, model: 'opus' }) })).json();
      const r = await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: status(1.25, 'Haiku') });
      expect(r.status).toBe(204);
      const u = (await call('GET', '/api/usage')).json();
      expect(u.today.costUsd).toBeCloseTo(1.25);
      expect(u.today.byModel).toEqual([{ key: 'claude-haiku', label: 'Haiku', tokensIn: 1000, tokensOut: 50, costUsd: 1.25 }]);
      expect(u.today.byStory.map((l: { label: string }) => l.label)).toEqual(['Payroll']);
      expect(u.limits.fiveHour).toEqual({ usedPercentage: 58, resetsAt: resets5 * 1000 });
      expect(mgr.get(c.id)!.model).toBe('Haiku');
    });

    it('accepts a status report only with the hook token, for a session that exists', async () => {
      const c = await newSession('claude');
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'user', body: status(1) })).status).toBe(403);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'none', body: status(1) })).status).toBe(403);
      expect((await call('POST', '/api/status/nope', { auth: 'hook', body: status(1) })).status).toBe(404);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: '{ nope' })).status).toBe(400);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: '"text"' })).status).toBe(400);
      expect((await call('GET', '/api/usage')).json().today.costUsd).toBe(0);
    });

    it('still accepts the last report of a session that has just exited', async () => {
      const c = await newSession('claude');
      ptys.last().exit(0);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: status(2) })).status).toBe(204);
      const u = (await call('GET', '/api/usage')).json();
      expect(u.limits.fiveHour.usedPercentage).toBe(58);
      expect(u.today.costUsd).toBeCloseTo(2);
    });
  });

  describe('folders', () => {
    it('lists sub-folders for the folder picker, and needs the token', async () => {
      mkdirSync(join(home.dir(), 'projects'));
      expect((await call('GET', `/api/folders?path=${encodeURIComponent(home.dir())}`, { auth: 'none' })).status).toBe(401);
      const r = await call('GET', `/api/folders?path=${encodeURIComponent(home.dir())}`);
      expect(r.status).toBe(200);
      expect(r.json().path).toBe(home.dir());
      expect(r.json().folders.map((f: { name: string }) => f.name)).toContain('projects');
    });

    it('answers 400 with the reason for a path that cannot be listed', async () => {
      const r = await call('GET', `/api/folders?path=${encodeURIComponent(join(home.dir(), 'nope'))}`);
      expect(r.status).toBe(400);
      expect(r.json().error).toMatch(/does not exist/i);
    });

    it('starts from the home folder with no path', async () => {
      expect((await call('GET', '/api/folders')).status).toBe(200);
    });
  });

  it('shuts down on request', async () => {
    expect((await call('POST', '/api/shutdown')).status).toBe(204);
    expect(shutdowns).toBe(1);
  });
});

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe.skipIf(!hasGit)('http api: git', () => {
  const home = useTempHome();
  let server: Server;
  let port = 0;
  let mgr: SessionManager;
  let root = '';
  let repo = '';
  let linked = '';
  let plain = '';
  let gitPtys = fakePtyFactory();

  const call = (method: string, path: string, opts: CallOpts = {}): Promise<Res> => callAt(port, method, path, opts);
  const q = (p: string): string => encodeURIComponent(p);
  const post = (path: string, body: unknown) => call('POST', path, { body: JSON.stringify(body) });
  const del = (path: string, body: unknown) => call('DELETE', path, { body: JSON.stringify(body) });
  const claudeIn = (cwd: string): SessionInfo => mgr.create({ kind: 'claude', command: process.execPath, cwd });
  const status = (body: Record<string, unknown>) => JSON.stringify({ model: { id: 'claude-opus', display_name: 'Opus' }, cost: { total_cost_usd: 1 }, ...body });

  beforeEach(async () => {
    gitPtys = fakePtyFactory();
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shellyard-http-git-')));
    repo = join(root, 'repo');
    linked = join(root, 'repo-feature');
    plain = join(root, 'plain');
    mkdirSync(repo);
    mkdirSync(plain);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'first');
    git(repo, 'worktree', 'add', '-b', 'feature', linked);

    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    const stories = new StoryStore();
    // The real git functions: no gitOf / headOf stubs here.
    mgr = new SessionManager({
      stories: () => stories.list(),
      ptyFactory: gitPtys.factory,
      now: Date.now,
      config: () => loadConfig().config,
      port,
      hookToken: HOOK_TOKEN,
      hookScriptPath: '/h.js', statusScriptPath: '/s.js',
      builtins: () => [builtin],
    });
    server.on('request', createRequestHandler({ manager: mgr, stories, recipes: new RecipeStore({ file: join(home.dir(), 'recipes.json') }), usage: new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') }), closed: new ClosedStore({ now: Date.now, file: join(home.dir(), 'closed.json') }), port, pageHost: PAGE, token: TOKEN, hookToken: HOOK_TOKEN, webDir: home.dir(), onShutdown: () => undefined }));
  });

  afterEach(async () => {
    mgr.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    removeDir(root);
  });

  it('needs the page token on every git route', async () => {
    const none = { auth: 'none' as const };
    const body = JSON.stringify({});
    expect((await call('GET', `/api/git/worktrees?path=${q(repo)}`, none)).status).toBe(401);
    expect((await call('GET', `/api/git/branches?path=${q(repo)}`, none)).status).toBe(401);
    expect((await call('GET', `/api/git/status?path=${q(repo)}`, none)).status).toBe(401);
    expect((await call('POST', '/api/git/worktrees', { ...none, body })).status).toBe(401);
    expect((await call('DELETE', '/api/git/worktrees', { ...none, body })).status).toBe(401);
    expect((await call('POST', '/api/git/switch', { ...none, body })).status).toBe(401);
    expect((await call('POST', '/api/sessions/x/worktree', { ...none, body })).status).toBe(401);
    expect((await call('GET', `/api/git/worktrees?path=${q(repo)}`, { auth: 'hook' })).status).toBe(401);
  });

  it('lists the worktrees of a repository, and null for a plain folder', async () => {
    const r = await call('GET', `/api/git/worktrees?path=${q(linked)}`);
    expect(r.status).toBe(200);
    const listing = r.json();
    expect(listing.worktrees).toHaveLength(2);
    expect(samePath(listing.current, linked)).toBe(true);
    expect(listing.worktrees.map((w: { branch: string }) => w.branch)).toEqual(['main', 'feature']);
    const p = await call('GET', `/api/git/worktrees?path=${q(plain)}`);
    expect(p.status).toBe(200);
    expect(p.json()).toBeNull();
  });

  it('answers 400 for a missing, relative or non-string path', async () => {
    for (const route of ['worktrees', 'branches', 'status']) {
      expect((await call('GET', `/api/git/${route}`)).status, route).toBe(400);
      expect((await call('GET', `/api/git/${route}?path=relative/dir`)).status, route).toBe(400);
    }
    expect((await post('/api/git/worktrees', { repo: 'repo', path: join(root, 'x'), branch: 'x', newBranch: true })).status).toBe(400);
    expect((await post('/api/git/worktrees', { repo, path: 'x', branch: 'x', newBranch: true })).status).toBe(400);
    expect((await post('/api/git/worktrees', { repo, path: 7, branch: 'x', newBranch: true })).status).toBe(400);
    expect((await del('/api/git/worktrees', { repo, path: 'repo-feature', force: false, deleteBranch: false })).status).toBe(400);
    expect((await del('/api/git/worktrees', { repo: '', path: linked, force: false, deleteBranch: false })).status).toBe(400);
    expect((await post('/api/git/switch', { path: 'repo', branch: 'x', create: true })).status).toBe(400);
    expect((await post('/api/git/switch', { path: null, branch: 'x', create: true })).status).toBe(400);
  });

  it('lists the uncommitted changes of a worktree and the diff of one file', async () => {
    const none = { auth: 'none' as const };
    expect((await call('GET', `/api/git/changes?path=${q(repo)}`, none)).status).toBe(401);
    expect((await call('GET', `/api/git/diff?path=${q(repo)}&file=a.txt`, none)).status).toBe(401);
    expect((await call('GET', `/api/git/changes?path=${q(repo)}`)).json()).toEqual({ worktree: repo, files: [], added: 0, removed: 0, truncated: false });
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    const c = (await call('GET', `/api/git/changes?path=${q(repo)}`)).json();
    expect(c.files).toEqual([{ path: 'a.txt', status: 'modified', added: 1, removed: 1 }]);
    const d = await call('GET', `/api/git/diff?path=${q(repo)}&file=a.txt`);
    expect(d.status).toBe(200);
    expect(d.json().diff).toContain('+b');
    // Only a changed file is read: anything else is refused with the reason.
    expect((await call('GET', `/api/git/diff?path=${q(repo)}&file=..%2Fplain`)).status).toBe(400);
    expect((await call('GET', `/api/git/diff?path=${q(repo)}`)).status).toBe(400);
    expect((await call('GET', `/api/git/changes?path=relative`)).status).toBe(400);
    expect((await call('GET', `/api/git/changes?path=${q(plain)}`)).json()).toBeNull();
  });

  it('lists branches and tells whether a worktree is dirty', async () => {
    expect((await call('GET', `/api/git/branches?path=${q(repo)}`)).json().sort()).toEqual(['feature', 'main']);
    expect((await call('GET', `/api/git/status?path=${q(repo)}`)).json()).toEqual({ dirty: false, unreachable: 0 });
    writeFileSync(join(repo, 'b.txt'), 'b');
    expect((await call('GET', `/api/git/status?path=${q(repo)}`)).json()).toEqual({ dirty: true, unreachable: 0 });
    // Not a worktree at all: git's complaint, as a 400.
    const r = await call('GET', `/api/git/status?path=${q(plain)}`);
    expect(r.status).toBe(400);
    expect(r.json().error).toBeTruthy();
  });

  it('creates a worktree (201, with the new listing) and refuses a bad branch with the reason', async () => {
    const path = join(root, 'repo-new');
    const r = await post('/api/git/worktrees', { repo, path, branch: 'new-thing', newBranch: true });
    expect(r.status).toBe(201);
    expect(r.json().worktrees.some((w: { path: string; branch: string }) => samePath(w.path, path) && w.branch === 'new-thing')).toBe(true);
    const bad = await post('/api/git/worktrees', { repo, path: join(root, 'repo-bad'), branch: 'bad..name', newBranch: true });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toBeTruthy();
    const dash = await post('/api/git/worktrees', { repo, path: join(root, 'repo-dash'), branch: '-x', newBranch: true });
    expect(dash.status).toBe(400);
    expect(dash.json().error).toMatch(/must not start with "-"/);
  });

  it('refuses to remove the main worktree, and removes a linked one', async () => {
    const main = await del('/api/git/worktrees', { repo, path: repo, force: false, deleteBranch: false });
    expect(main.status).toBe(400);
    expect(main.json().error).toMatch(/main worktree/i);
    const r = await del('/api/git/worktrees', { repo, path: linked, force: false, deleteBranch: true });
    expect(r.status).toBe(200);
    expect(r.json().listing.worktrees).toHaveLength(1);
    expect(r.json().warning).toBeNull();
    expect(git(repo, 'branch', '--list', 'feature')).toBe('');
  });

  it('refreshes the sessions of a removed worktree and of the rest of the repository', async () => {
    const inLinked = claudeIn(linked);
    const inMain = claudeIn(repo);
    await vi.waitFor(() => expect(mgr.get(inLinked.id)!.git?.worktreeCount).toBe(2));
    await vi.waitFor(() => expect(mgr.get(inMain.id)!.git?.worktreeCount).toBe(2));
    expect((await del('/api/git/worktrees', { repo, path: linked, force: true, deleteBranch: false })).status).toBe(200);
    await vi.waitFor(() => expect(mgr.get(inMain.id)!.git?.worktreeCount).toBe(1));
    await vi.waitFor(() => expect(mgr.get(inLinked.id)!.git).toBeNull());
  });

  it('switches the branch of a worktree (204), and only of a worktree', async () => {
    const r = await post('/api/git/switch', { path: linked, branch: 'other', create: true });
    expect(r.status).toBe(204);
    expect(headOf(linked)?.branch).toBe('other');
    expect((await post('/api/git/switch', { path: plain, branch: 'x', create: true })).status).toBe(422);
    const sub = join(linked, 'sub');
    mkdirSync(sub);
    expect((await post('/api/git/switch', { path: sub, branch: 'y', create: true })).status).toBe(422);
    const taken = await post('/api/git/switch', { path: linked, branch: 'main', create: false });
    expect(taken.status).toBe(400);
    expect(taken.json().error).toBeTruthy();
  });

  it('restarts a session in another worktree of its repository', async () => {
    const s = claudeIn(repo);
    await vi.waitFor(() => expect(mgr.get(s.id)!.git).not.toBeNull());
    const r = await post(`/api/sessions/${s.id}/worktree`, { path: linked });
    expect(r.status).toBe(200);
    expect(samePath(r.json().cwd, linked)).toBe(true);
    expect(r.json().id).toBe(s.id);
    await vi.waitFor(() => expect(samePath(mgr.get(s.id)!.git?.worktree ?? '', linked)).toBe(true));
  });

  it('refuses to restart a session in a folder that is not a worktree of its repository', async () => {
    const s = claudeIn(repo);
    expect((await post(`/api/sessions/${s.id}/worktree`, { path: plain })).status).toBe(422);
    expect((await post(`/api/sessions/${s.id}/worktree`, { path: 'repo-feature' })).status).toBe(400);
    expect((await post(`/api/sessions/${s.id}/worktree`, { path: 3 })).status).toBe(400);
    expect((await post('/api/sessions/nope/worktree', { path: linked })).status).toBe(404);
    expect(samePath(mgr.get(s.id)!.cwd, repo)).toBe(true);
  });

  it('follows the folder a hook reports into the linked worktree', async () => {
    const s = claudeIn(repo);
    await vi.waitFor(() => expect(mgr.get(s.id)!.git).not.toBeNull());
    const r = await call('POST', `/api/hooks/${s.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: linked }) });
    expect(r.status).toBe(204);
    expect(mgr.get(s.id)!.liveCwd).toBe(linked);
    await vi.waitFor(() => expect(samePath(mgr.get(s.id)!.git?.worktree ?? '', linked)).toBe(true));
  });

  it('follows the folder a status report names, preferring the workspace folder', async () => {
    const s = claudeIn(repo);
    const r = await call('POST', `/api/status/${s.id}`, { auth: 'hook', body: status({ cwd: plain, workspace: { current_dir: linked } }) });
    expect(r.status).toBe(204);
    expect(mgr.get(s.id)!.liveCwd).toBe(linked);
    await call('POST', `/api/status/${s.id}`, { auth: 'hook', body: status({ cwd: plain }) });
    expect(mgr.get(s.id)!.liveCwd).toBe(plain);
  });

  it('ignores late reports of the conversation a restart replaced', async () => {
    const s = claudeIn(repo);
    const old = mgr.conversationOf(s.id)!;
    mgr.restartIn(s.id, linked);
    const fresh = mgr.conversationOf(s.id)!;
    expect(fresh).not.toBe(old);

    const stale = await call('POST', `/api/hooks/${s.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: old, cwd: plain }) });
    expect(stale.status).toBe(204);
    const staleStatus = await call('POST', `/api/status/${s.id}`, { auth: 'hook', body: status({ session_id: old, cwd: plain }) });
    expect(staleStatus.status).toBe(204);
    expect(mgr.conversationOf(s.id)).toBe(fresh);
    expect(mgr.get(s.id)!.liveCwd).toBeNull();
    expect(mgr.get(s.id)!.status).toBe('idle');
    expect(mgr.get(s.id)!.model).toBeNull();
    expect((await call('GET', '/api/usage')).json().today.costUsd).toBe(0);

    const current = await call('POST', `/api/hooks/${s.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: fresh, cwd: plain }) });
    expect(current.status).toBe(204);
    expect(mgr.get(s.id)!.liveCwd).toBe(plain);
    expect(mgr.get(s.id)!.status).toBe('working');
    expect(mgr.conversationOf(s.id)).toBe(fresh);

    // The new process has reported, so the old one is gone: the user may /resume its conversation.
    const resumed = await call('POST', `/api/hooks/${s.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Stop', session_id: old, cwd: repo }) });
    expect(resumed.status).toBe(204);
    expect(mgr.conversationOf(s.id)).toBe(old);
    expect(mgr.get(s.id)!.liveCwd).toBe(repo);
  });

  it('refuses to move a session that sets its own folder with --cd', async () => {
    const s = mgr.create({ kind: 'shell', command: process.execPath, args: ['--cd', '/home/me'], cwd: repo });
    const r = await post(`/api/sessions/${s.id}/worktree`, { path: linked });
    expect(r.status).toBe(422);
    expect(r.json().error).toMatch(/--cd/);
    expect(samePath(mgr.get(s.id)!.cwd, repo)).toBe(true);
  });

  it('waits for the process of a closed session in the worktree to end before removing it', async () => {
    const s = mgr.create({ kind: 'shell', command: process.execPath, cwd: linked });
    const p = gitPtys.last();
    // Like a real process, it ends a while after it is killed.
    p.kill = () => {
      p.killed = true;
    };
    mgr.remove(s.id);
    let settled = false;
    const pending = del('/api/git/worktrees', { repo, path: linked, force: false, deleteBranch: false }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    p.exit(1);
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.json().listing.worktrees).toHaveLength(1);
  });

  it('starts from a ticket: a worktree on its branch, an area in it, the recipe sessions with their prompt', async () => {
    const recipe = (await post('/api/recipes', { name: 'Bug fix', repo, base: 'main', branch: 'feat/{ticket-lower}', folder: '{repo}-{ticket-lower}', sessions: [{ profileId: 'builtin-node', prompt: '' }] })).json();
    expect(recipe.id).toBeTruthy();
    const r = await post('/api/tickets', { recipeId: recipe.id, ticket: 'proj-7912' });
    expect(r.status).toBe(201);
    const out = r.json();
    const worktree = `${repo}-proj-7912`;
    expect(out.story).toMatchObject({ name: 'PROJ-7912', ticket: 'PROJ-7912', cwd: worktree });
    expect(out.sessions).toEqual([expect.objectContaining({ storyId: out.story.id, cwd: worktree })]);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/proj-7912');
    expect((await post('/api/tickets', { recipeId: recipe.id, ticket: 'PROJ-7912' })).status).toBe(409);
  });

  it('says what git says when the worktree cannot be made, and makes no area', async () => {
    const recipe = (await post('/api/recipes', { name: 'Odd', repo, base: 'no-such-base', branch: 'feat/{ticket-lower}', folder: '{repo}-{ticket-lower}', sessions: [{ profileId: 'builtin-node', prompt: '' }] })).json();
    const r = await post('/api/tickets', { recipeId: recipe.id, ticket: 'PROJ-1' });
    expect(r.status).toBe(409);
    expect((await call('GET', '/api/recipes')).json()).toHaveLength(1);
    expect(loadConfig().config.stories).toEqual([]);
  });
});

describe('http api: errors', () => {
  const home = useTempHome();
  let server: Server;
  let port = 0;
  let errors: ErrorReporter;
  let usage: UsageStore;
  let revealed: string[] = [];

  const call = (method: string, path: string, opts: CallOpts = {}): Promise<Res> => callAt(port, method, path, opts);

  beforeEach(async () => {
    revealed = [];
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    const stories = new StoryStore();
    const mgr = new SessionManager({
      stories: () => stories.list(),
      ptyFactory: fakePtyFactory().factory,
      now: Date.now,
      config: () => loadConfig().config,
      port,
      hookToken: HOOK_TOKEN,
      hookScriptPath: '/h.js', statusScriptPath: '/s.js',
      builtins: () => [builtin],
      gitOf: async () => null,
      headOf: () => null,
    });
    errors = new ErrorReporter({ dir: join(home.dir(), 'errors'), now: Date.now, version: '1.0.0', secrets: () => [TOKEN, HOOK_TOKEN] });
    usage = new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') });
    server.on(
      'request',
      createRequestHandler({
        manager: mgr,
        stories,
        usage,
        closed: new ClosedStore({ now: Date.now, file: join(home.dir(), 'closed.json') }),
        errors,
        reveal: (file) => {
          revealed.push(file);
          return null;
        },
        port,
        pageHost: PAGE,
        token: TOKEN,
        hookToken: HOOK_TOKEN,
        webDir: home.dir(),
        onShutdown: () => undefined,
      }),
    );
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('answers an unexpected failure with a 500 that says where its report is', async () => {
    vi.spyOn(usage, 'summary').mockImplementation(() => {
      throw new Error(`exploded near ${TOKEN}`);
    });
    const r = await call('GET', '/api/usage');
    expect(r.status).toBe(500);
    const [report] = errors.list();
    expect(report).toMatchObject({ source: 'server', context: 'GET /api/usage', message: 'Error: exploded near [redacted]' });
    expect(r.json().error).toBe(`Internal error. Details in ${report!.file}`);
    expect(readFileSync(report!.file, 'utf8')).not.toContain(TOKEN);
  });

  it('writes a report for an error of the page, lists it, and marks it seen', async () => {
    const none = { auth: 'none' as const };
    expect((await call('GET', '/api/errors', none)).status).toBe(401);
    expect((await call('POST', '/api/errors', { ...none, body: JSON.stringify({ message: 'x' }) })).status).toBe(401);
    const r = await call('POST', '/api/errors', { body: JSON.stringify({ message: 'TypeError: x is undefined', stack: 'at App', context: 'page: board' }) });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ source: 'page', message: 'TypeError: x is undefined', context: 'page: board', seen: false });
    expect(readFileSync(r.json().file, 'utf8')).toContain('at App');
    expect((await call('GET', '/api/errors')).json()).toHaveLength(1);
    expect((await call('POST', `/api/errors/${r.json().id}/seen`)).status).toBe(204);
    expect(errors.list()[0]!.seen).toBe(true);
    expect((await call('POST', '/api/errors/nope/seen')).status).toBe(404);
  });

  it('refuses a page report without a message', async () => {
    expect((await call('POST', '/api/errors', { body: JSON.stringify({}) })).status).toBe(400);
    expect((await call('POST', '/api/errors', { body: JSON.stringify({ message: 'x', stack: 3 }) })).status).toBe(400);
  });

  it('shows the file of a report of this run, never a path from the request', async () => {
    const report = errors.report({ source: 'server', error: 'boom' })!;
    expect((await call('POST', `/api/errors/${report.id}/reveal`)).status).toBe(204);
    expect(revealed).toEqual([report.file]);
    expect((await call('POST', `/api/errors/${encodeURIComponent('/etc/passwd')}/reveal`)).status).toBe(404);
    expect((await call('GET', `/api/errors/${report.id}/reveal`)).status).toBe(405);
    expect(revealed).toHaveLength(1);
  });

  it('marks every report seen at once', async () => {
    errors.report({ source: 'server', error: 'a' });
    errors.report({ source: 'server', error: 'b' });
    expect((await call('POST', '/api/errors/seen')).status).toBe(204);
    expect(errors.list().every((r) => r.seen)).toBe(true);
  });
});
