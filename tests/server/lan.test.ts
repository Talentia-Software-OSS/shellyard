import { readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity, connect, type PeerCertificate } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { isAllowedRemote, isLanHost, isPrivateIPv4, LanAccess, lanAddresses, lanGate, readAuthority, readLanToken } from '../../src/server/lan.js';
import type { LanAddress, LanStatus } from '../../src/shared/types.js';
import { useTempHome } from '../helpers.js';

describe('isPrivateIPv4', () => {
  it('takes the private, link-local and carrier-grade NAT ranges', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.9.9', '192.168.1.23', '169.254.3.4', '100.64.0.1', '100.127.255.254']) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
    }
  });
  it('refuses public addresses, loopback and what is not an IPv4 address', () => {
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1', '127.0.0.1', '256.1.1.1', '10.0.0', 'fe80::1', 'example.com', '']) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });
});

describe('isAllowedRemote', () => {
  it('lets in this computer and private networks, also as IPv4-mapped IPv6', () => {
    for (const a of ['127.0.0.1', '::1', '192.168.1.7', '::ffff:192.168.1.7', '::FFFF:10.1.2.3', '100.101.102.103']) expect(isAllowedRemote(a), a).toBe(true);
  });
  it('refuses the internet and anything it cannot read', () => {
    for (const a of ['8.8.8.8', '::ffff:8.8.8.8', 'fe80::1', '2001:db8::1', '', undefined]) expect(isAllowedRemote(a), String(a)).toBe(false);
  });
});

describe('isLanHost', () => {
  it('answers an IPv4 address with the right port', () => {
    expect(isLanHost('192.168.1.23:7718', 7718)).toBe(true);
    expect(isLanHost('127.0.0.1:7718', 7718)).toBe(true);
  });
  it('refuses names (DNS rebinding), another port, a missing port and IPv6', () => {
    expect(isLanHost('evil.example:7718', 7718)).toBe(false);
    expect(isLanHost('192.168.1.23.nip.io:7718', 7718)).toBe(false);
    expect(isLanHost(`${'a'.repeat(32)}.localhost:7718`, 7718)).toBe(false);
    expect(isLanHost('192.168.1.23:7717', 7718)).toBe(false);
    expect(isLanHost('192.168.1.23', 7718)).toBe(false);
    expect(isLanHost('[::1]:7718', 7718)).toBe(false);
    expect(isLanHost('999.1.1.1:7718', 7718)).toBe(false);
    expect(isLanHost(undefined, 7718)).toBe(false);
  });
});

describe('lanAddresses', () => {
  const nic = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceInfo =>
    ({ address, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 }) as unknown as NetworkInterfaceInfo;

  it('lists private IPv4 addresses, Wi-Fi and Ethernet before virtual adapters', () => {
    const found = lanAddresses({
      'vEthernet (WSL)': [nic('172.20.0.1')],
      'Loopback Pseudo-Interface 1': [nic('127.0.0.1', 'IPv4', true)],
      'Wi-Fi': [nic('fe80::1', 'IPv6'), nic('192.168.1.23')],
      'Some VPN': [nic('8.8.4.4')],
      'Ethernet': [nic('10.0.0.5')],
      'Tailscale': [nic('100.100.1.2')],
    });
    expect(found).toEqual([
      { name: 'Wi-Fi', ip: '192.168.1.23' },
      { name: 'Ethernet', ip: '10.0.0.5' },
      { name: 'Tailscale', ip: '100.100.1.2' },
      { name: 'vEthernet (WSL)', ip: '172.20.0.1' },
    ]);
  });
});

describe('lanGate', () => {
  const lan = { enabled: true, port: () => 7718, token: () => 'x'.repeat(64) };
  const req = (host: string, remoteAddress: string): IncomingMessage => ({ headers: { host }, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('lets in a private network by IP address, never with the powers of this computer', () => {
    const gate = lanGate(lan);
    expect(gate.local).toBe(false);
    expect(gate.classify(req('192.168.1.23:7718', '192.168.1.7'))).toBe('page');
    // 127.0.0.1 is only an address here: still a page, never "loopback".
    expect(gate.classify(req('127.0.0.1:7718', '127.0.0.1'))).toBe('page');
  });
  it('refuses the internet, names and everything while switched off', () => {
    const gate = lanGate(lan);
    expect(gate.classify(req('192.168.1.23:7718', '8.8.8.8'))).toBe('foreign');
    expect(gate.classify(req('evil.example:7718', '192.168.1.7'))).toBe('foreign');
    expect(lanGate({ ...lan, enabled: false }).classify(req('192.168.1.23:7718', '192.168.1.7'))).toBe('foreign');
  });
  it('allows only its own HTTPS origin and names its secure WebSocket in the policy', () => {
    const gate = lanGate(lan);
    const r = req('192.168.1.23:7718', '192.168.1.7');
    expect(gate.originAllowed('https://192.168.1.23:7718', r)).toBe(true);
    expect(gate.originAllowed('https://evil.example', r)).toBe(false);
    expect(gate.originAllowed('http://192.168.1.23:7718', r)).toBe(false);
    expect(gate.originAllowed(undefined, r)).toBe(false);
    expect(gate.wsOrigin(r)).toBe('wss://192.168.1.23:7718');
  });
});

describe('LanAccess', () => {
  const home = useTempHome();
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(() => r(undefined)));
    }
  });
  const make = (addresses: () => LanAddress[] = () => [{ name: 'Wi-Fi', ip: '192.168.1.23' }]): LanAccess => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    return new LanAccess({ server, preferredPort: () => 0, host: '127.0.0.1', addresses, authorityName: 'ShellYard on TEST' });
  };
  /** The certificate served on the port, checked against the root as a phone that installed it would; null if nothing answers. */
  const served = (a: LanAccess, as = '192.168.1.23'): Promise<{ authorized: boolean; cert: PeerCertificate } | null> =>
    new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: a.port(), ca: a.certificate().pem, rejectUnauthorized: false, checkServerIdentity: (_h, c) => checkServerIdentity(as, c) });
      socket.once('secureConnect', () => {
        resolve({ authorized: socket.authorized, cert: socket.getPeerCertificate() });
        socket.destroy();
      });
      socket.once('error', () => resolve(null));
    });
  const reachable = async (a: LanAccess): Promise<boolean> => (await served(a)) !== null;

  it('makes the token on first need, keeps it on disk readable by the user only, and reads it back', () => {
    const a = make();
    expect(a.knownToken()).toBeNull();
    const token = a.token();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readLanToken()).toBe(token);
    if (process.platform !== 'win32') expect(statSync(join(home.dir(), 'lan.json')).mode & 0o777).toBe(0o600);
    expect(make().token()).toBe(token);
  });

  it('ignores a token file that is not one of its own', () => {
    writeFileSync(join(home.dir(), 'lan.json'), JSON.stringify({ token: 'short' }));
    expect(readLanToken()).toBeNull();
    expect(make().token()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a new link replaces the token, on disk too', () => {
    const a = make();
    const before = a.token();
    a.newLink();
    expect(a.token()).not.toBe(before);
    expect(JSON.parse(readFileSync(join(home.dir(), 'lan.json'), 'utf8')).token).toBe(a.token());
  });

  it('listens only while switched on, and says so to its listeners', async () => {
    const a = make();
    const seen: LanStatus[] = [];
    a.onChange((s) => seen.push(s));
    expect(a.status()).toMatchObject({ enabled: false, clients: 0 });
    expect(a.info().links).toEqual([]);

    await a.start();
    await a.start();
    const port = a.port();
    expect(port).toBeGreaterThan(0);
    expect(await reachable(a)).toBe(true);
    expect(a.info().links).toEqual([
      { name: 'Wi-Fi', ip: '192.168.1.23', url: `https://192.168.1.23:${port}/#token=${a.token()}`, setupUrl: `https://192.168.1.23:${port}/setup` },
    ]);
    expect(a.info().certificate).toEqual({ name: 'ShellYard on TEST', fingerprint: a.certificate().fingerprint });

    await a.stop();
    expect(await reachable(a)).toBe(false);
    expect(seen.map((s) => s.enabled)).toEqual([true, false]);
    expect(seen[1]!.revision).toBeGreaterThan(seen[0]!.revision);

    // And again: the same server object listens again after being closed.
    await a.start();
    expect(await reachable(a)).toBe(true);
    await a.stop();
  });

  it('serves a certificate of its root for this computer, which a phone that trusts the root accepts', async () => {
    const a = make();
    await a.start();
    const s = await served(a);
    expect(s?.authorized).toBe(true);
    expect(s?.cert.subjectaltname).toBe('IP Address:192.168.1.23');
    expect(s?.cert.issuer.CN).toBe('ShellYard on TEST');
    // An address the certificate does not name is refused.
    expect((await served(a, '192.168.1.99'))?.authorized).toBe(false);
    await a.stop();
  });

  it('keeps its root on disk, readable by the user only, and makes a new one if the file is damaged', () => {
    const a = make();
    const root = a.certificate();
    expect(readAuthority()?.cert).toBe(root.pem);
    if (process.platform !== 'win32') expect(statSync(join(home.dir(), 'lan-ca.json')).mode & 0o777).toBe(0o600);
    // Kept: another start trusts the same root, so phones do not install it again.
    expect(make().certificate().fingerprint).toBe(root.fingerprint);
    writeFileSync(join(home.dir(), 'lan-ca.json'), JSON.stringify({ name: 'x', cert: 'not a certificate', key: 'nope' }));
    expect(readAuthority()).toBeNull();
    expect(make().certificate().fingerprint).not.toBe(root.fingerprint);
  });

  it('makes the certificate again when the addresses change or its end is near, never otherwise', async () => {
    let addresses: LanAddress[] = [{ name: 'Wi-Fi', ip: '192.168.1.23' }];
    const a = make(() => addresses);
    await a.start();
    expect(a.refreshCertificate()).toBe(false);
    addresses = [{ name: 'Wi-Fi', ip: '10.0.0.7' }];
    expect(a.refreshCertificate()).toBe(true);
    const s = await served(a, '10.0.0.7');
    expect(s?.authorized).toBe(true);
    expect(s?.cert.subjectaltname).toBe('IP Address:10.0.0.7');
    expect(a.refreshCertificate()).toBe(false);
    expect(a.refreshCertificate(new Date(Date.now() + 70 * 24 * 60 * 60 * 1000))).toBe(true);
    await a.stop();
  });

  it('keeps phone access off unless config.json says true', () => {
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ lan: { enabled: 'yes', port: 80 } }));
    expect(loadConfig().config.lan).toEqual({ enabled: false, port: 7718 });
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ lan: { enabled: true, port: 9000 } }));
    expect(loadConfig().config.lan).toEqual({ enabled: true, port: 9000 });
  });
});
