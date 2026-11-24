import { createPrivateKey, X509Certificate } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { LanAddress, LanInfo, LanStatus } from '../shared/types.js';
import { newToken, type Gate } from './auth.js';
import { dataDir } from './config.js';
import { listenOnFirstFree } from './listen.js';
import { certificateDer, createAuthority, fingerprint, issueServerCertificate, type Authority, type ServerCertificate } from './x509.js';

// Phone access: the same page, served to the devices of the local network on a listener of its
// own, which exists only while the user has it switched on. Whoever reaches it with the link gets
// what the page gets on this computer, a shell as the user, so it is held to its own rules:
// - it is reached by an IPv4 address only, never by a name: a page on another site that makes a
//   name of its own point at this computer (DNS rebinding) is refused;
// - it answers this computer and private networks only (home, office, Tailscale);
// - it takes its own token, never the per-start one of the loopback listener, and the loopback
//   listener never takes this one;
// - it serves neither the hooks, nor the status reports, nor the shutdown: those are for the
//   processes of this computer;
// - it speaks HTTPS only, with a certificate of ShellYard's own root (x509.ts), which each phone
//   trusts once. The token never crosses the network in the clear, and a program that takes the
//   port while ShellYard is off cannot pass for it: a phone that trusts the root refuses it
//   before sending anything. The root itself is public; only its key, kept here, is secret.
// Off by default, and a "new link" cuts off every device holding the old one.

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

function authorityPath(): string {
  return join(dataDir(), 'lan-ca.json');
}

/** The root kept on disk, if it is whole: a certificate that parses and the key that goes with it. */
export function readAuthority(): Authority | null {
  try {
    const raw = JSON.parse(readFileSync(authorityPath(), 'utf8')) as Partial<Authority> | null;
    if (typeof raw?.name !== 'string' || typeof raw.cert !== 'string' || typeof raw.key !== 'string') return null;
    const x = new X509Certificate(raw.cert);
    if (!x.ca || !x.checkPrivateKey(createPrivateKey(raw.key)) || new Date(x.validTo).getTime() < Date.now()) return null;
    return { name: raw.name, cert: raw.cert, key: raw.key };
  } catch {
    return null;
  }
}

function writeAuthority(a: Authority): void {
  const path = authorityPath();
  // Its key can make certificates every phone that trusts it accepts: readable by the user only.
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(a, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // As for the token.
  }
}

/** How often the certificate is checked against this computer's addresses and its end. */
const CERT_CHECK_MS = 60_000;
/** A certificate this close to its end is made again. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/** What phone access needs from the WebSocket attached to its listener. */
export interface LanSockets {
  clientCount(): number;
  /** Closes every connected page, as when the link changes or access is switched off. */
  disconnectAll(): void;
}

export interface LanAccessOptions {
  /**
   * The HTTPS listener, made once with the request handler and the WebSocket attached and no
   * certificate: it is given one, and started and stopped, here.
   */
  server: Server;
  /** The port tried first, read at each start (config.json). */
  preferredPort: () => number;
  /** Every interface by default; tests listen on loopback. */
  host?: string;
  /** Stands in for the computer's network adapters, in tests. */
  addresses?: () => LanAddress[];
  /** The name the root is made with; the phone shows it among its trusted certificates. */
  authorityName?: string;
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
  private root: Authority | null = null;
  private served: ServerCertificate | null = null;
  private certTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: LanAccessOptions) {}

  /** The root, read from disk or made (and kept) the first time it is needed. */
  private authority(): Authority {
    if (this.root === null) {
      this.root = readAuthority();
      if (this.root === null) {
        this.root = createAuthority(this.opts.authorityName ?? `ShellYard on ${hostname()}`);
        writeAuthority(this.root);
      }
    }
    return this.root;
  }

  /** The root as the phone installs it: its name, its fingerprint, its certificate (PEM and DER). */
  certificate(): { name: string; fingerprint: string; pem: string; der: Buffer } {
    const a = this.authority();
    return { name: a.name, fingerprint: fingerprint(a.cert), pem: a.cert, der: certificateDer(a.cert) };
  }

  /**
   * Makes the certificate of this computer again when its addresses changed or its end is near,
   * and hands it to the listener: connections from then on get the new one. True if it changed.
   */
  refreshCertificate(now: Date = new Date()): boolean {
    const ips = this.addresses().map((a) => a.ip);
    const current = this.served;
    const same = current !== null && current.ips.length === ips.length && current.ips.every((ip) => ips.includes(ip));
    if (same && current.notAfter.getTime() - now.getTime() > RENEW_BEFORE_MS) return false;
    this.served = issueServerCertificate(this.authority(), ips, now);
    this.opts.server.setSecureContext({ key: this.served.key, cert: this.served.cert });
    return true;
  }

  private addresses(): LanAddress[] {
    return (this.opts.addresses ?? lanAddresses)();
  }

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
      // The listener never answers without a certificate of the root.
      this.served = null;
      this.refreshCertificate();
      this.boundPort = await listenOnFirstFree(this.opts.server, this.opts.preferredPort(), this.opts.host ?? '0.0.0.0');
      this.listening = true;
      this.certTimer = setInterval(() => {
        // A new address (DHCP, another network) is in the certificate within a minute.
        if (this.listening && this.refreshCertificate()) this.emit();
      }, CERT_CHECK_MS);
      this.certTimer.unref?.();
      this.revisionCount++;
      this.emit();
    });
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      if (!this.listening) return;
      this.listening = false;
      if (this.certTimer) clearInterval(this.certTimer);
      this.certTimer = null;
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
      addresses: this.addresses(),
      clients: this.listening ? (this.sockets?.clientCount() ?? 0) : 0,
      revision: this.revisionCount,
    };
  }

  /** The status with the links, which carry the token, and the root the phone installs first. */
  info(): LanInfo {
    const status = this.status();
    const links = status.enabled
      ? status.addresses.map((a) => ({ ...a, url: `https://${a.ip}:${status.port}/#token=${this.token()}`, setupUrl: `https://${a.ip}:${status.port}/setup` }))
      : [];
    const { name, fingerprint: fp } = this.certificate();
    return { ...status, links, certificate: { name, fingerprint: fp } };
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
      return origin !== undefined && isLanHost(host, lan.port()) && origin.toLowerCase() === `https://${host}`;
    },
    wsOrigin: (req) => `wss://${req.headers.host ?? ''}`,
  };
}
