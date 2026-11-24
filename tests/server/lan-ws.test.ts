import { createServer, type Server } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultConfig } from '../../src/server/config.js';
import { LanAccess, lanGate } from '../../src/server/lan.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { attachWebSocket, type WebSocketHandle } from '../../src/server/ws.js';
import type { ServerMessage } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const TOKEN = 't'.repeat(64);
const PAGE = 'a'.repeat(32) + '.localhost';
const PHONE_IP = '192.168.1.23';

describe('phone access over the websocket', () => {
  useTempHome();
  let lanServer: Server;
  let lan: LanAccess;
  let handle: WebSocketHandle;
  let changes = 0;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    changes = 0;
    lanServer = createServer();
    lan = new LanAccess({ server: lanServer, preferredPort: () => 0, host: '127.0.0.1', addresses: () => [{ name: 'Wi-Fi', ip: PHONE_IP }] });
    const manager = new SessionManager({ ptyFactory: fakePtyFactory().factory, now: Date.now, config: defaultConfig, port: 1, hookToken: 'h', hookScriptPath: '/h.js', statusScriptPath: '/s.js', builtins: () => [], gitOf: async () => null, headOf: () => null });
    handle = attachWebSocket(lanServer, { manager, lan, port: 1, pageHost: PAGE, token: TOKEN, gate: lanGate(lan), onClients: () => lan.changed() });
    lan.attachSockets(handle);
    lan.onChange(() => changes++);
    await lan.start();
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await lan.stop();
    handle.close();
  });

  const host = (): string => `${PHONE_IP}:${lan.port()}`;
  function open(o: { host?: string; origin?: string; token?: string } = {}): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
    return new Promise((resolve, reject) => {
      // Over TLS, trusting only the root and checking the phone's address, as a set-up phone does.
      // (ws hands these to tls.connect; its typings describe checkServerIdentity otherwise.)
      const tlsOptions: import('node:tls').ConnectionOptions = { ca: lan.certificate().pem, checkServerIdentity: (_h, cert) => checkServerIdentity(PHONE_IP, cert) };
      const ws = new WebSocket(`wss://127.0.0.1:${lan.port()}/ws`, ['shellyard', `shellyard-token.${o.token ?? lan.token()}`], {
        headers: { host: o.host ?? host(), origin: o.origin ?? `https://${host()}` },
        ...(tlsOptions as object),
      });
      sockets.push(ws);
      const messages: ServerMessage[] = [];
      ws.on('message', (d) => messages.push(JSON.parse(String(d))));
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    });
  }

  it('opens with the phone token from its own origin, and is told phone access is on', async () => {
    const c = await open();
    await waitUntil(() => c.messages.some((m) => m.t === 'lan'));
    const lanMessage = c.messages.find((m): m is Extract<ServerMessage, { t: 'lan' }> => m.t === 'lan')!;
    expect(lanMessage.lan.enabled).toBe(true);
    expect(JSON.stringify(c.messages)).not.toContain(lan.token());
    await waitUntil(() => lan.status().clients === 1);
  });

  it('refuses the token of this start, another origin and a name', async () => {
    await expect(open({ token: TOKEN })).rejects.toThrow(/refused 401/);
    await expect(open({ origin: 'https://evil.example' })).rejects.toThrow(/refused 403/);
    // Its own address over plain HTTP is another origin.
    await expect(open({ origin: `http://${host()}` })).rejects.toThrow(/refused 403/);
    await expect(open({ host: `evil.example:${lan.port()}`, origin: `http://evil.example:${lan.port()}` })).rejects.toThrow(/refused 403/);
    await expect(open({ host: `${PAGE}:${lan.port()}`, origin: `http://${PAGE}:${lan.port()}` })).rejects.toThrow(/refused 403/);
  });

  it('a new link disconnects the pages and keeps the old link out', async () => {
    const old = lan.token();
    const c = await open();
    let closed = false;
    c.ws.on('close', () => (closed = true));
    const before = changes;
    lan.newLink();
    await waitUntil(() => closed);
    expect(lan.status().clients).toBe(0);
    expect(changes).toBeGreaterThan(before);
    await expect(open({ token: old })).rejects.toThrow(/refused 401/);
    await open();
  });

  it('switching off disconnects the pages', async () => {
    const c = await open();
    let closed = false;
    c.ws.on('close', () => (closed = true));
    await lan.stop();
    await waitUntil(() => closed);
    expect(lan.status()).toMatchObject({ enabled: false, clients: 0 });
  });
});
