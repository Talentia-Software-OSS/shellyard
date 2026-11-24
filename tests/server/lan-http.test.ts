import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
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

type CallOptions = { host: string; token?: string; hookToken?: string; origin?: string; body?: string; binary?: boolean };

/**
 * A raw request to 127.0.0.1:port with any Host, token and Origin. With `tls`, over HTTPS,
 * trusting only that root and checking the certificate for the phone's address, as a phone does.
 */
function call(port: number, method: string, path: string, o: CallOptions, tls?: { ca: string }): Promise<Res & { body: Buffer }> {
  const headers: Record<string, string> = { host: o.host };
  if (o.token) headers['x-shellyard-token'] = o.token;
  if (o.hookToken) headers['x-shellyard-hook-token'] = o.hookToken;
  if (o.origin) headers.origin = o.origin;
  if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method, path, headers };
    const onResponse = (res: import('node:http').IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body, json: () => JSON.parse(text) });
      });
    };
    const req = tls
      ? httpsRequest({ ...options, ca: tls.ca, checkServerIdentity: (_h, cert) => checkServerIdentity(PHONE_IP, cert) }, onResponse)
      : request(options, onResponse);
    req.on('error', reject);
    req.end(o.body);
  });
}

describe('phone access over https', () => {
  const home = useTempHome();
  let local: Server;
  let lanServer: HttpsServer;
  let localPort = 0;
  let lan: LanAccess;
  let shutdowns = 0;

  const lanHost = (): string => `${PHONE_IP}:${lan.port()}`;
  const onLan = (method: string, path: string, o: { token?: string; hookToken?: string; origin?: string; body?: string; host?: string } = {}): Promise<Res & { body: Buffer }> =>
    call(lan.port(), method, path, { host: lanHost(), ...o }, { ca: lan.certificate().pem });
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
    lanServer = createHttpsServer();
    lan = new LanAccess({ server: lanServer, preferredPort: () => 0, host: '127.0.0.1', addresses: () => [{ name: 'Wi-Fi', ip: PHONE_IP }], authorityName: 'ShellYard on TEST' });
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
    expect(String(r.headers['content-security-policy'])).toContain(`connect-src 'self' wss://${lanHost()};`);
  });

  it('speaks HTTPS only: a plain HTTP request gets nothing', async () => {
    const plain = await call(lan.port(), 'GET', '/', { host: lanHost() }).then(
      (r) => r.status,
      () => 'refused',
    );
    expect(plain === 'refused' || (typeof plain === 'number' && plain >= 400)).toBe(true);
  });

  it('serves a new phone the setup page and the root, without the token', async () => {
    const page = await onLan('GET', '/setup');
    expect(page.status).toBe(200);
    expect(page.text).toContain('ShellYard on TEST');
    expect(page.text).toContain(lan.certificate().fingerprint);
    expect(page.text).toContain('href="/shellyard-certificate.crt"');
    expect(page.text).not.toContain(lan.token());
    expect(page.text).not.toContain('<script');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");

    const cert = await onLan('GET', '/shellyard-certificate.crt');
    expect(cert.status).toBe(200);
    expect(cert.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect(cert.body.equals(lan.certificate().der)).toBe(true);
  });

  it('the setup page and the root are for the phone listener only', async () => {
    const page = await onLocal('GET', '/setup');
    expect(page.text).not.toContain('Set up this phone');
    expect((await onLocal('GET', '/shellyard-certificate.crt')).headers['content-type']).not.toBe('application/x-x509-ca-cert');
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
    expect((await onLan('POST', '/api/sessions', { token: lan.token(), origin: 'https://evil.example', body })).status).toBe(403);
    expect((await onLan('POST', '/api/sessions', { token: lan.token(), origin: `http://${lanHost()}`, body })).status).toBe(403);
    expect((await onLan('POST', '/api/sessions', { token: lan.token(), origin: `https://${lanHost()}`, body })).status).toBe(201);
  });

  it('switches on and off from the page, and keeps the choice in config.json', async () => {
    const info = (await onLocal('GET', '/api/lan', { token: TOKEN })).json();
    expect(info).toMatchObject({
      enabled: true,
      links: [{ name: 'Wi-Fi', ip: PHONE_IP, url: `https://${lanHost()}/#token=${lan.token()}`, setupUrl: `https://${lanHost()}/setup` }],
      certificate: { name: 'ShellYard on TEST', fingerprint: lan.certificate().fingerprint },
    });

    const port = lan.port();
    const off = await onLocal('PUT', '/api/lan', { token: TOKEN, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, links: [] });
    expect(lan.enabled).toBe(false);
    expect(loadConfig().config.lan.enabled).toBe(false);
    await expect(call(port, 'GET', '/', { host: `${PHONE_IP}:${port}` }, { ca: lan.certificate().pem })).rejects.toThrow();

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
    const r = await onLan('POST', '/api/lan/new-link', { token: old, origin: `https://${lanHost()}` });
    expect(r.status).toBe(204);
    await waitUntil(() => lan.token() !== old);
  });
});
