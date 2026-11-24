import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// Certificates for phone access over HTTPS, made with Node's own crypto: no dependency.
//
// ShellYard is its own small certificate authority. The phone trusts its root once; the root
// then vouches for the certificate of this computer's addresses, which is made again whenever
// they change or it comes near its end, without the phone noticing. The root is limited by a
// name constraint to the private IPv4 ranges and to the reserved name "invalid": even if its key
// were stolen, a phone that trusts it would refuse a certificate it signed for any real site.
//
// The encoding is DER (X.690) of X.509 v3 (RFC 5280), only as much of it as these two
// certificates need. Keys are ECDSA P-256, signatures ECDSA with SHA-256.

/** The ranges the root may vouch for: the private ranges phone access answers (lan.ts). */
export const PERMITTED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
];

/** How long the root lasts. */
const AUTHORITY_YEARS = 10;
/** How long a certificate of this computer lasts; phones refuse server certificates over 825 days. */
export const SERVER_DAYS = 90;
/** Backdating, for phones whose clock is a little behind. */
const SKEW_MS = 24 * 60 * 60 * 1000;

const OID = {
  commonName: '2.5.4.3',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  nameConstraints: '2.5.29.30',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
};

// --- DER ------------------------------------------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content);
const boolTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));

/** A BIT STRING whose last `unused` bits are padding. */
const bits = (unused: number, b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const group = [p % 128];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) group.unshift(0x80 | v % 128);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

/** An INTEGER from unsigned big-endian bytes, in its shortest form and never negative. */
function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function time(d: Date): Buffer {
  const two = (n: number): string => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const rest = `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  // UTCTime up to 2049, GeneralizedTime from 2050 (RFC 5280, 4.1.2.5).
  return y < 2050 ? tlv(0x17, Buffer.from(two(y % 100) + rest, 'ascii')) : tlv(0x18, Buffer.from(String(y) + rest, 'ascii'));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid(OID.commonName), utf8(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolTrue()] : []), octets(value));
}

function ipv4Bytes(ip: string): Buffer {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`Not an IPv4 address: ${ip}`);
  return Buffer.from(parts);
}

function maskBytes(prefix: number): Buffer {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return Buffer.from([mask >>> 24, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff]);
}

// GeneralName, implicitly tagged (RFC 5280, 4.2.1.6): dNSName [2], iPAddress [7].
const dnsName = (s: string): Buffer => tlv(0x82, Buffer.from(s, 'ascii'));
const ipAddress = (b: Buffer): Buffer => tlv(0x87, b);

// --- Certificates ---------------------------------------------------------------------------

/** The root: its certificate and key (PEM), and the name it signs with. */
export interface Authority {
  name: string;
  cert: string;
  key: string;
}

export interface ServerCertificate {
  cert: string;
  key: string;
  /** The addresses it is valid for. */
  ips: string[];
  notAfter: Date;
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** The DER of a PEM certificate. */
export function certificateDer(certPem: string): Buffer {
  return Buffer.from(certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64');
}

/** The SHA-256 fingerprint as phones show it: pairs of hex digits, colon-separated. */
export function fingerprint(certPem: string): string {
  return (createHash('sha256').update(certificateDer(certPem)).digest('hex').toUpperCase().match(/../g) ?? []).join(':');
}

/** A key identifier: a hash of the public key (RFC 7093, method 1). */
function keyId(spki: Buffer): Buffer {
  return createHash('sha256').update(spki).digest().subarray(0, 20);
}

function newKeyPair(): { spki: Buffer; keyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { spki: publicKey.export({ type: 'spki', format: 'der' }), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

function serial(): Buffer {
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f;
  return b;
}

function signCertificate(tbs: Buffer, signerKeyPem: string): string {
  const signature = sign('sha256', tbs, signerKeyPem);
  return pem('CERTIFICATE', sequence(tbs, sequence(oid(OID.ecdsaWithSha256)), bits(0, signature)));
}

function tbsCertificate(o: { issuer: string; subject: string; notBefore: Date; notAfter: Date; spki: Buffer; extensions: Buffer[] }): Buffer {
  return sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial()),
    sequence(oid(OID.ecdsaWithSha256)),
    name(o.issuer),
    sequence(time(o.notBefore), time(o.notAfter)),
    name(o.subject),
    o.spki,
    explicit(3, sequence(...o.extensions)),
  );
}

/** A new root, limited to the private IPv4 ranges. */
export function createAuthority(commonName: string, now: Date = new Date()): Authority {
  const { spki, keyPem } = newKeyPair();
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + AUTHORITY_YEARS);
  const permitted = [...PERMITTED_RANGES.map(([ip, prefix]) => sequence(ipAddress(Buffer.concat([ipv4Bytes(ip), maskBytes(prefix)])))),
    // With a dNSName subtree present, every DNS name must fall under it: "invalid" is reserved
    // (RFC 2606) and never names a real site, so the root vouches for no DNS name at all.
    sequence(dnsName('invalid'))];
  const tbs = tbsCertificate({
    issuer: commonName,
    subject: commonName,
    notBefore: new Date(now.getTime() - SKEW_MS),
    notAfter,
    spki,
    extensions: [
      extension(OID.basicConstraints, true, sequence(boolTrue(), integer(Buffer.from([0])))),
      // keyCertSign (bit 5) and cRLSign (bit 6).
      extension(OID.keyUsage, true, bits(1, Buffer.from([0x06]))),
      extension(OID.nameConstraints, true, sequence(tlv(0xa0, Buffer.concat(permitted)))),
      extension(OID.subjectKeyIdentifier, false, octets(keyId(spki))),
    ],
  });
  return { name: commonName, cert: signCertificate(tbs, keyPem), key: keyPem };
}

/**
 * A certificate for this computer's addresses, signed by the root. `dnsNames` exists for the
 * tests, which check that the root's constraint makes phones refuse such names.
 */
export function issueServerCertificate(authority: Authority, ips: string[], now: Date = new Date(), days: number = SERVER_DAYS, dnsNames: string[] = []): ServerCertificate {
  const { spki, keyPem } = newKeyPair();
  const authoritySpki = createPublicKey(authority.cert).export({ type: 'spki', format: 'der' });
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const extensions = [
    extension(OID.basicConstraints, true, sequence()),
    // digitalSignature (bit 0): what an ECDSA key does in TLS.
    extension(OID.keyUsage, true, bits(7, Buffer.from([0x80]))),
    extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
    extension(OID.subjectKeyIdentifier, false, octets(keyId(spki))),
    extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, keyId(authoritySpki)))),
  ];
  const altNames = [...dnsNames.map(dnsName), ...ips.map((ip) => ipAddress(ipv4Bytes(ip)))];
  if (altNames.length > 0) extensions.push(extension(OID.subjectAltName, false, sequence(...altNames)));
  const tbs = tbsCertificate({
    issuer: authority.name,
    subject: 'ShellYard phone access',
    notBefore: new Date(now.getTime() - SKEW_MS),
    notAfter,
    spki,
    extensions,
  });
  return { cert: signCertificate(tbs, authority.key), key: keyPem, ips: [...ips], notAfter };
}
