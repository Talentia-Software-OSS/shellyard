import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { checkServerIdentity, connect, createServer, type Server } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthority, fingerprint, issueServerCertificate, type Authority, type ServerCertificate } from '../../src/server/x509.js';

const PHONE_IP = '192.168.1.23';
const DAY = 24 * 60 * 60 * 1000;

describe('certificates for phone access', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  });

  /** A real TLS handshake with OpenSSL's verification, the root as the only trusted one, checking `as`. */
  async function handshake(trusted: Authority, served: ServerCertificate, as: string): Promise<{ authorized: boolean; error: string | null }> {
    const server = createServer({ key: served.key, cert: served.cert }, (s) => s.end());
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port, ca: trusted.cert, rejectUnauthorized: false, checkServerIdentity: (_h, cert) => checkServerIdentity(as, cert) });
      socket.once('secureConnect', () => {
        resolve({ authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null });
        socket.destroy();
      });
      socket.once('error', (e) => resolve({ authorized: false, error: e.message }));
    });
  }

  it('makes a root that is a CA, signed by itself, for ten years', () => {
    const now = new Date('2026-11-24T10:00:00Z');
    const root = createAuthority('ShellYard on TEST', now);
    const x = new X509Certificate(root.cert);
    expect(x.ca).toBe(true);
    expect(x.subject).toBe('CN=ShellYard on TEST');
    expect(x.issuer).toBe(x.subject);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2036);
    expect(fingerprint(root.cert)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(fingerprint(root.cert)).toBe(x.fingerprint256);
  });

  it('issues a server certificate for the addresses, as phones require it', () => {
    const now = new Date();
    const root = createAuthority('ShellYard on TEST', now);
    const served = issueServerCertificate(root, [PHONE_IP, '10.0.0.5'], now);
    const x = new X509Certificate(served.cert);
    const ca = new X509Certificate(root.cert);
    expect(x.ca).toBe(false);
    expect(x.checkIssued(ca)).toBe(true);
    expect(x.verify(ca.publicKey)).toBe(true);
    expect(x.checkIP(PHONE_IP)).toBe(PHONE_IP);
    expect(x.checkIP('10.0.0.5')).toBe('10.0.0.5');
    expect(x.checkIP('192.168.1.24')).toBeUndefined();
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    // iOS refuses TLS server certificates valid for more than 825 days.
    expect(new Date(x.validTo).getTime() - new Date(x.validFrom).getTime()).toBeLessThan(825 * DAY);
  });

  it('passes a real TLS check for its address, trusting only the root', async () => {
    const root = createAuthority('ShellYard on TEST');
    const result = await handshake(root, issueServerCertificate(root, [PHONE_IP]), PHONE_IP);
    expect(result).toEqual({ authorized: true, error: null });
  });

  it('fails the check for another root, or once expired', async () => {
    const root = createAuthority('ShellYard on TEST');
    const other = createAuthority('Someone else');
    expect((await handshake(root, issueServerCertificate(other, [PHONE_IP]), PHONE_IP)).authorized).toBe(false);
    const expired = issueServerCertificate(root, [PHONE_IP], new Date(Date.now() - 100 * DAY), 90);
    const result = await handshake(root, expired, PHONE_IP);
    expect(result.authorized).toBe(false);
    expect(result.error).toMatch(/CERT_HAS_EXPIRED|expired/i);
  });

  it('the root cannot vouch for a public address or any DNS name, even if its key is stolen', async () => {
    const root = createAuthority('ShellYard on TEST');
    // OpenSSL refuses these with "permitted subtree violation" (error 47), which Node reports as
    // UNSPECIFIED. Every other reason (wrong issuer, expiry, name mismatch) has a name of its own,
    // and the same certificate for a private address passes (above).
    const otherReasons = /UNABLE_TO|SELF_SIGNED|EXPIRED|NOT_YET_VALID|ALTNAME|SIGNATURE/;
    const publicIp = await handshake(root, issueServerCertificate(root, ['8.8.8.8']), '8.8.8.8');
    expect(publicIp.authorized).toBe(false);
    expect(publicIp.error).not.toMatch(otherReasons);
    const site = issueServerCertificate(root, [], new Date(), 90, ['www.example.com']);
    const dns = await handshake(root, site, 'www.example.com');
    expect(dns.authorized).toBe(false);
    expect(dns.error).not.toMatch(otherReasons);
  });
});
