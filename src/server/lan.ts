import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { LanAddress, LanInfo, LanStatus } from '../shared/types.js';
import { newToken, type Gate } from './auth.js';
import { dataDir } from './config.js';
import { listenOnFirstFree } from './listen.js';

// Phone access: the same page, served to the devices of the local network on a listener of its
// own, which exists only while the user has it switched on. Whoever reaches it with the link gets
// what the page gets on this computer, a shell as the user, so it is held to its own rules:
// - it is reached by an IPv4 address only, never by a name: a page on another site that makes a
//   name of its own point at this computer (DNS rebinding) is refused;
// - it answers this computer and private networks only (home, office, Tailscale);
// - it takes its own token, never the per-start one of the loopback listener, and the loopback
//   listener never takes this one;
// - it serves neither the hooks, nor the status reports, nor the shutdown: those are for the
//   processes of this computer.
// The connection is plain HTTP, as protected as the network it crosses: hence off by default,
// and a "new link" that cuts off every device holding the old one.

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** 10/8, 172.16/12, 192.168/16, link-local 169.254/16, and 100.64/10 (carrier-grade NAT, Tailscale). */
export function isPrivateIPv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b] = p as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Whether a connection from this address may use phone access: this computer, or a private network. */
export function isAllowedRemote(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  const p = ipv4Parts(v4);
  if (!p) return false;
  return p[0] === 127 || isPrivateIPv4(v4);
}

/** A Host header phone access answers: an IPv4 address and its port, never a name. */
export function isLanHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const m = /^([0-9.]+):(\d{1,5})$/.exec(host);
  return m !== null && Number(m[2]) === port && ipv4Parts(m[1]!) !== null;
}

// Adapters that are not the network a phone is on: virtual switches (WSL, Hyper-V, Docker,
// VirtualBox, VMware), tunnels and the like. They are still listed, after the others.
const VIRTUAL = /vethernet|virtual|vmware|vmnet|vbox|docker|wsl|hyper-v|default switch|^br-|^virbr|^veth|^bridge|^utun|^awdl|^llw|bluetooth|loopback|npcap/i;
const PHYSICAL = /wi-?fi|wlan|wireless|^wl|^en\d|^eth|^enp|^eno|^ens|ethernet/i;

function rank(name: string): number {
  if (VIRTUAL.test(name)) return 2;
  return PHYSICAL.test(name) ? 0 : 1;
}

/** This computer's IPv4 addresses on private networks, Wi-Fi and Ethernet first. */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanAddress[] {
  const found: LanAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4' || !isPrivateIPv4(a.address)) continue;
      if (!found.some((f) => f.ip === a.address)) found.push({ name, ip: a.address });
    }
  }
  return found
    .map((a, i) => ({ a, i, r: rank(a.name) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.a);
}

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

function tokenPath(): string {
  return join(dataDir(), 'lan.json');
}

/** The token of the phone link, kept across restarts so that a phone's bookmark keeps working. */
export function readLanToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(tokenPath(), 'utf8')) as { token?: unknown } | null;
    return typeof raw?.token === 'string' && TOKEN_SHAPE.test(raw.token) ? raw.token : null;
  } catch {
    return null;
  }
}

function writeLanToken(token: string): void {
  const path = tokenPath();
  // Like server.json, it grants a shell: readable by the user only, from the moment it exists.
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every file system; the home folder's own permissions still apply.
  }
}

/** What phone access needs from the WebSocket attached to its listener. */
export interface LanSockets {
  clientCount(): number;
  /** Closes every connected page, as when the link changes or access is switched off. */
  disconnectAll(): void;
}

export interface LanAccessOptions {
  /** The listener, made once with the request handler and the WebSocket attached; only started and stopped here. */
  server: Server;
  /** The port tried first, read at each start (config.json). */
  preferredPort: () => number;
  /** Every interface by default; tests listen on loopback. */
  host?: string;
  /** Stands in for the computer's network adapters, in tests. */
  addresses?: () => LanAddress[];
}

export class LanAccess {
  private sockets: LanSockets | null = null;
  private listening = false;
  private boundPort: number | null = null;
  private cachedToken: string | null = null;
  private revisionCount = 0;
  private readonly listeners: Array<(s: LanStatus) => void> = [];
  /** Starts and stops run one after the other: a quick on-off-on must not bind twice. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LanAccessOptions) {}

  attachSockets(sockets: LanSockets): void {
    this.sockets = sockets;
  }

  get enabled(): boolean {
    return this.listening;
  }

  /** The port it listens on; while off, the one it will try first. */
  port(): number {
    return this.boundPort ?? this.opts.preferredPort();
  }

  /** The token of the link, made (and kept on disk) the first time it is needed. */
  token(): string {
    if (this.cachedToken === null) {
      this.cachedToken = readLanToken();
      if (this.cachedToken === null) {
        this.cachedToken = newToken();
        writeLanToken(this.cachedToken);
      }
    }
    return this.cachedToken;
  }

  /** The token if it has been read or made in this run; for taking it out of error reports without making one. */
  knownToken(): string | null {
    return this.cachedToken;
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.listening) return;
      this.token();
      this.boundPort = await listenOnFirstFree(this.opts.server, this.opts.preferredPort(), this.opts.host ?? '0.0.0.0');
      this.listening = true;
      this.revisionCount++;
      this.emit();
    });
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      if (!this.listening) return;
      this.listening = false;
      this.sockets?.disconnectAll();
      const { server } = this.opts;
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
      this.boundPort = null;
      this.revisionCount++;
      this.emit();
    });
  }

  /** A new link: every device holding the old one is disconnected, and refused from then on. */
  newLink(): void {
    this.cachedToken = newToken();
    writeLanToken(this.cachedToken);
    this.revisionCount++;
    this.sockets?.disconnectAll();
    this.opts.server.closeAllConnections();
    this.emit();
  }

  status(): LanStatus {
    return {
      enabled: this.listening,
      port: this.port(),
      addresses: (this.opts.addresses ?? lanAddresses)(),
      clients: this.listening ? (this.sockets?.clientCount() ?? 0) : 0,
      revision: this.revisionCount,
    };
  }

  /** The status with the links, which carry the token. */
  info(): LanInfo {
    const status = this.status();
    const links = status.enabled ? status.addresses.map((a) => ({ ...a, url: `http://${a.ip}:${status.port}/#token=${this.token()}` })) : [];
    return { ...status, links };
  }

  onChange(cb: (s: LanStatus) => void): void {
    this.listeners.push(cb);
  }

  /** Something the status shows has changed (a phone connected or left). */
  changed(): void {
    this.emit();
  }

  private emit(): void {
    const s = this.status();
    for (const cb of this.listeners) cb(s);
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** The gate of the phone listener (see the top of this file). */
export function lanGate(lan: Pick<LanAccess, 'enabled' | 'port' | 'token'>): Gate {
  return {
    local: false,
    classify: (req) => (lan.enabled && isAllowedRemote(req.socket.remoteAddress) && isLanHost(req.headers.host, lan.port()) ? 'page' : 'foreign'),
    token: () => lan.token(),
    originAllowed: (origin, req) => {
      const host = req.headers.host;
      return origin !== undefined && isLanHost(host, lan.port()) && origin.toLowerCase() === `http://${host}`;
    },
    wsOrigin: (req) => `ws://${req.headers.host ?? ''}`,
  };
}
