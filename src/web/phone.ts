import qrcode from 'qrcode-generator';

// Phone access, as the page sees it: the QR code of the link, and whether this page itself was
// opened through it (from a phone, the address is the computer's IP, not a name of its own).

/** True when the page was opened by an IPv4 address: through phone access, not on this computer. */
export function onPhoneLink(hostname: string = location.hostname): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.startsWith('127.');
}

/**
 * The QR code of a text as one SVG path, one unit per module, and the number of modules on a
 * side. Drawn by the page itself (no markup from the library), dark on white so phones read it
 * in every theme.
 */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, d };
}
