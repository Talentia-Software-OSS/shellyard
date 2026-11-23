import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newChallenge } from '../../src/server/auth.js';
import { ClosedStore } from '../../src/server/closed.js';
import { loadConfig } from '../../src/server/config.js';
import { createRequestHandler, type HttpDeps } from '../../src/server/http.js';
import { LanAccess, lanGate } from '../../src/server/lan.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { StoryStore } from '../../src/server/stories.js';
import { UsageStore } from '../../src/server/usage.js';
import type { Profile } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const TOKEN = 't'.repeat(64);
const HOOK_TOKEN = 'h'.repeat(64);
const PAGE = 'c'.repeat(32) + '.localhost';
const PHONE_IP = '192.168.1.23';
const builtin: Profile = { id: 'builtin-node', name: 'Node', kind: 'shell', command: process.execPath, args: [], cwd: '', color: '#123456', env: {}, model: null };

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => any;
}

/** A raw request to 127.0.0.1:port with any Host, token and Origin. */
function call(port: number, method: string, path: string, o: { host: string; token?: string; hookToken?: string; origin?: string; body?: string }): Promise<Res> {
  const headers: Record<string, string> = { host: o.host };
  if (o.token) headers['x-shellyard-token'] = o.token;
  if (o.hookToken) headers['x-shellyard-hook-token'] = o.hookToken;
  if (o.origin) headers.origin = o.origin;
  if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

describe('phone access over http', () => {
  const home = useTempHome();
  let local: Server;
  let lanServer: Server;
  let localPort = 0;
  let lan: LanAccess;
  let shutdowns = 0;

  const lanHost = (): string => `${PHONE_IP}:${lan.port()}`;
  const onLan = (method: string, path: string, o: { token?: string; hookToken?: string; origin?: string; body?: string; host?: string } = {}): Promise<Res> =>
    call(lan.port(), method, path, { host: lanHost(), ...o });
  const onLocal = (method: string, path: string, o: { token?: string; origin?: string; body?: string } = {}): Promise<Res> =>
    call(localPort, method, path, { host: `${PAGE}:${localPort}`, ...o });

  beforeEach(async () => {
    shutdowns = 0;
    const webDir = join(home.dir(), 'web');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<html>ShellYard APP</html>');
    local = createServer();
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    localPort = (local.address() as AddressInfo).port;
    const stories = new StoryStore();
    const manager = new SessionManager({
      stories: () => stories.list(),
      ptyFactory: fakePtyFactory().factory,
      now: Date.now,
      config: () => loadConfig().config,
      port: localPort,
      hookToken: HOOK_TOKEN,
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [builtin],
      gitOf: async () => null,
      headOf: () => null,
    });
    lanServer = createServer();
    lan = new LanAccess({ server: lanServer, preferredPort: () => 0, host: '127.0.0.1', addresses: () => [{ name: 'Wi-Fi', ip: PHONE_IP }] });
    const deps: HttpDeps = {
      manager,
      stories,
      usage: new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') }),
      closed: new ClosedStore({ now: Date.now, file: join(home.dir(), 'closed.json') }),
      lan,
      port: localPort,
      pageHost: PAGE,
      token: TOKEN,
      hookToken: HOOK_TOKEN,
      webDir,
      onShutdown: () => shutdowns++,
    };
    local.on('request', createRequestHandler(deps));
    lanServer.on('request', createRequestHandler({ ...deps, gate: lanGate(lan) }));
    await lan.start();
  });

  afterEach(async () => {
    await lan.stop();
    local.closeAllConnections();
    await new Promise((r) => local.close(r));
  });

  it('serves the page by IP address, its policy naming the WebSocket of that address', async () => {
    const r = await onLan('GET', '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('ShellYard APP');
    expect(String(r.headers['content-security-policy'])).toContain(`connect-src 'self' ws://${lanHost()};`);
  });

  it('takes the phone token, and neither nothing nor the token of this start', async () => {
    expect((await onLan('GET', '/api/sessions')).status).toBe(401);
    expect((await onLan('GET', '/api/sessions', { token: TOKEN })).status).toBe(401);
    expect((await onLan('GET', '/api/sessions', { token: lan.token() })).status).toBe(200);
  });

  it('the loopback listener does not take the phone token', async () => {
    expect((await onLocal('GET', '/api/sessions', { token: lan.token() })).status).toBe(401);
    expect((await onLocal('GET', '/api/sessions', { token: TOKEN })).status).toBe(200);
  });

  it('refuses names, the page host of this start and another port', async () => {
    expect((await onLan('GET', '/', { host: `evil.example:${lan.port()}` })).status).toBe(403);
    expect((await onLan('GET', '/api/sessions', { host: `${PAGE}:${lan.port()}`, token: lan.token() })).status).toBe(403);
    expect((await onLan('GET', '/api/sessions', { host: `${PHONE_IP}:1`, token: lan.token() })).status).toBe(403);
  });

  it('serves no hooks, status reports or shutdown, even to 127.0.0.1 with every token', async () => {
    const host = `127.0.0.1:${lan.port()}`;
    expect((await onLan('POST', '/api/hooks/x', { host, hookToken: HOOK_TOKEN, body: '{}' })).status).toBe(404);
    expect((await onLan('POST', '/api/status/x', { host, hookToken: HOOK_TOKEN, body: '{}' })).status).toBe(404);
    expect((await onLan('POST', '/api/shutdown', { host, token: lan.token() })).status).toBe(404);
    expect(shutdowns).toBe(0);
  });

  it('answers health without the proof only the loopback listener gives', async () => {
    const r = await onLan('GET', `/api/health?challenge=${newChallenge()}`);
    expect(r.status).toBe(200);
    expect(r.json().proof).toBeUndefined();
  });

  it('lets its own origin change things and refuses another one', async () => {
    const body = JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir() });
    expect((await onLan('POST', '/api/sessions', { token: lan.token(), origin: 'http://evil.example', body })).status).toBe(403);
    expect((await onLan('POST', '/api/sessions', { token: lan.token(), origin: `http://${lanHost()}`, body })).status).toBe(201);
  });

  it('switches on and off from the page, and keeps the choice in config.json', async () => {
    const info = (await onLocal('GET', '/api/lan', { token: TOKEN })).json();
    expect(info).toMatchObject({ enabled: true, links: [{ name: 'Wi-Fi', ip: PHONE_IP, url: `http://${lanHost()}/#token=${lan.token()}` }] });

    const port = lan.port();
    const off = await onLocal('PUT', '/api/lan', { token: TOKEN, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, links: [] });
    expect(lan.enabled).toBe(false);
    expect(loadConfig().config.lan.enabled).toBe(false);
    await expect(call(port, 'GET', '/', { host: `${PHONE_IP}:${port}` })).rejects.toThrow();

    const on = await onLocal('PUT', '/api/lan', { token: TOKEN, body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    expect(on.json().enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(home.dir(), 'config.json'), 'utf8')).lan.enabled).toBe(true);
    expect((await onLocal('PUT', '/api/lan', { token: TOKEN, body: '{"enabled":"yes"}' })).status).toBe(400);
  });

  it('a new link shuts out the old one', async () => {
    const old = lan.token();
    const r = await onLocal('POST', '/api/lan/new-link', { token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.json().links[0].url).toContain(lan.token());
    expect((await onLan('GET', '/api/sessions', { token: old })).status).toBe(401);
    expect((await onLan('GET', '/api/sessions', { token: lan.token() })).status).toBe(200);
  });

  it('asked from a phone, answers first, then makes the new link', async () => {
    const old = lan.token();
    const r = await onLan('POST', '/api/lan/new-link', { token: old, origin: `http://${lanHost()}` });
    expect(r.status).toBe(204);
    await waitUntil(() => lan.token() !== old);
  });
});
