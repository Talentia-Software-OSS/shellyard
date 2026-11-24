import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

// Whoever reaches this server gets a shell as the user. It only listens on loopback, but a
// web page open in the user's browser can still send requests to loopback, so every request
// is checked: a secret token, the Host header (DNS rebinding) and the Origin.
//
// The token is never an ambient credential. A cookie for 127.0.0.1 is sent by the browser to
// every port on the machine, so any other local server the user visits would receive it. The
// page keeps the token itself and sends it explicitly: in a header on API calls, and in the
// subprotocol list of the WebSocket handshake (the one place a browser lets a page put it).

export const WS_PROTOCOL = 'shellyard';
export const WS_TOKEN_PREFIX = 'shellyard-token.';

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** A challenge the shellyard command sends to /api/health: 32 random bytes as hex. */
export function newChallenge(): string {
  return randomBytes(32).toString('hex');
}

export function isChallenge(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * What the server answers to a health challenge: proof that it holds the token, without
 * sending the token. Anything can listen on the recorded port after a crash; only the server
 * that wrote the state file can compute this, and nothing it returns can be replayed.
 */
export function healthProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(`shellyard-health:${challenge}`).digest('hex');
}

// The page is never served on a fixed address. An origin that is the same at every start
// (http://127.0.0.1:7717) can be prepared in advance: whoever holds the port while ShellYard is
// down (another user of the machine can) may leave a service worker there, and at the next
// start that worker, not the server, answers the launcher and reads the token from the
// address. So each start picks a new host name nobody can guess, under .localhost, which
// browsers resolve to the loopback address by themselves: http://<32 hex>.localhost:<port>.

/** A fresh host name for the page: 16 random bytes as hex, under .localhost. */
export function newPageHost(): string {
  return `${randomBytes(16).toString('hex')}.localhost`;
}

/** The address the page is served on. */
export function pageOrigin(pageHost: string, port: number): string {
  return `http://${pageHost}:${port}`;
}

/**
 * What a Host header names:
 * - "page": the page's host of this start;
 * - "loopback": 127.0.0.1, which the shellyard command, the hooks and the status line use;
 * - "stale-page": the page's host of an earlier start, from a tab left open, which is told
 *   that the server was restarted;
 * - "foreign": anything else (DNS rebinding, another port), refused.
 */
export type HostKind = 'page' | 'loopback' | 'stale-page' | 'foreign';

export function classifyHost(hostHeader: string | undefined, port: number, pageHost: string): HostKind {
  if (!hostHeader) return 'foreign';
  const host = hostHeader.toLowerCase();
  if (host === `${pageHost}:${port}`) return 'page';
  // Not "localhost": the system may resolve that name to something else (a hosts file, IPv6).
  if (host === `127.0.0.1:${port}`) return 'loopback';
  if (new RegExp(`^[0-9a-f]{32}\\.localhost:${port}$`).test(host)) return 'stale-page';
  return 'foreign';
}

/** Only the page of this start may send requests that change something. */
export function originAllowed(origin: string | undefined, port: number, pageHost: string): boolean {
  if (!origin) return false;
  return origin.toLowerCase() === pageOrigin(pageHost, port);
}

/**
 * What a listener lets in. The loopback listener and the phone (LAN) listener share the request
 * handler and the WebSocket code; each passes its own gate, so the two never lend each other
 * their address checks or their token.
 */
export interface Gate {
  /** True for the loopback listener: only it serves the hooks, status reports and shutdown. */
  local: boolean;
  /** What the request's Host (and, for the LAN, its sender) is to this listener. */
  classify(req: IncomingMessage): HostKind;
  /** The token the page must present on this listener. */
  token(): string;
  /** Whether a request from this Origin may change something (and open the WebSocket). */
  originAllowed(origin: string | undefined, req: IncomingMessage): boolean;
  /** The WebSocket origin the page's Content-Security-Policy names. */
  wsOrigin(req: IncomingMessage): string;
}

/** The gate of the loopback listener: the page of this start, and the shellyard command and hooks on 127.0.0.1. */
export function localGate(port: number, pageHost: string, token: string): Gate {
  return {
    local: true,
    classify: (req) => classifyHost(req.headers.host, port, pageHost),
    token: () => token,
    originAllowed: (origin) => originAllowed(origin, port, pageHost),
    wsOrigin: () => `ws://${pageHost}:${port}`,
  };
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function requestAuthorized(headers: IncomingHttpHeaders, token: string): boolean {
  if (!token) return false;
  const given = headers['x-shellyard-token'];
  return typeof given === 'string' && safeEqual(given, token);
}

/**
 * The token a WebSocket client offered in Sec-WebSocket-Protocol, as "shellyard, shellyard-token.<token>".
 * Null unless both the protocol name and a token are there.
 */
export function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  const offered = header.split(',').map((p) => p.trim());
  if (!offered.includes(WS_PROTOCOL)) return null;
  const entry = offered.find((p) => p.startsWith(WS_TOKEN_PREFIX));
  const token = entry ? entry.slice(WS_TOKEN_PREFIX.length) : '';
  return token || null;
}
