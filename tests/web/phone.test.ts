import { describe, expect, it } from 'vitest';
import { onPhoneLink, qrPath } from '../../src/web/phone.js';

describe('onPhoneLink', () => {
  it('is true for a page opened by an IP address of the network', () => {
    expect(onPhoneLink('192.168.1.23')).toBe(true);
    expect(onPhoneLink('10.0.0.5')).toBe(true);
  });
  it('is false on this computer: its page name, or loopback', () => {
    expect(onPhoneLink(`${'a'.repeat(32)}.localhost`)).toBe(false);
    expect(onPhoneLink('127.0.0.1')).toBe(false);
    expect(onPhoneLink('localhost')).toBe(false);
  });
});

describe('qrPath', () => {
  it('draws a square code with its three finder patterns', () => {
    const { size, d } = qrPath(`http://192.168.1.23:7718/#token=${'0123456789abcdef'.repeat(4)}`);
    // Version 1 is 21 modules; every version adds 4.
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 21) % 4).toBe(0);
    // The corners of the three finder patterns are dark; the fourth corner is not one.
    expect(d).toContain('M0 0h1v1h-1z');
    expect(d).toContain(`M${size - 1} 0h1v1h-1z`);
    expect(d).toContain(`M0 ${size - 1}h1v1h-1z`);
  });
  it('gives the same drawing for the same text, another for another', () => {
    expect(qrPath('a').d).toBe(qrPath('a').d);
    expect(qrPath('a').d).not.toBe(qrPath('b').d);
  });
});
