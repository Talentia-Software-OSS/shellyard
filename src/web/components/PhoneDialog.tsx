import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LanInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { onPhoneLink, qrPath } from '../phone.js';
import { useStore } from '../store.js';

/** Margin around the QR code, in modules: readers need a quiet zone of four. */
const QUIET = 4;

/** Phone access: switch it on, scan the link, make a new one. */
export function PhoneDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { lan } = useStore();
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);
  const here = onPhoneLink();

  // Read again whenever the status says the link may have changed: on, off, a new link, a new
  // port, another network. The status itself never carries the link.
  const changeKey = lan ? `${lan.enabled}|${lan.port}|${lan.revision}|${lan.addresses.map((a) => a.ip).join(',')}` : '';
  useEffect(() => {
    let live = true;
    api
      .lan()
      .then((i) => live && setInfo(i))
      .catch((e: unknown) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [changeKey]);

  const run = async (change: () => Promise<LanInfo | undefined>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await change();
      if (next) setInfo(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enabled = info?.enabled ?? lan?.enabled ?? false;
  const links = info?.links ?? [];
  const link = links.find((l) => l.ip === picked) ?? links[0] ?? null;
  const qr = useMemo(() => (link ? qrPath(link.url) : null), [link?.url]);
  const clients = lan?.clients ?? info?.clients ?? 0;

  const copy = async (): Promise<void> => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('The clipboard is not available here: scan the code instead.');
    }
  };

  return createPortal(
    <div
      className="overlay"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog phone-dialog" role="dialog" aria-label="Phone access">
        <h2>Phone access</h2>
        <p className="hint">Open ShellYard on a phone or tablet on the same network as this computer: the same sessions, terminals and answers as here.</p>
        <label className="check">
          <input type="checkbox" checked={enabled} disabled={busy || info === null} onChange={(e) => void run(() => api.setLan(e.target.checked))} />
          <span>Let devices on this network open ShellYard</span>
        </label>
        {here && <p className="hint">You are on the phone link: switching it off, or making a new link, disconnects this page too.</p>}
        {error && <p className="error">{error}</p>}
        {enabled && links.length === 0 && (
          <p className="hint">This computer has no address on a local network right now. Connect it to your Wi-Fi and it shows up here.</p>
        )}
        {enabled && link && qr && (
          <>
            {links.length > 1 && (
              <label>
                <span>Network</span>
                <select value={link.ip} onChange={(e) => setPicked(e.target.value)}>
                  {links.map((l) => (
                    <option key={l.ip} value={l.ip}>
                      {l.name} · {l.ip}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="phone-qr">
              <svg
                viewBox={`${-QUIET} ${-QUIET} ${qr.size + 2 * QUIET} ${qr.size + 2 * QUIET}`}
                shapeRendering="crispEdges"
                role="img"
                aria-label={`QR code of the link on ${link.ip}`}
              >
                <rect x={-QUIET} y={-QUIET} width={qr.size + 2 * QUIET} height={qr.size + 2 * QUIET} fill="#fff" />
                <path d={qr.d} fill="#000" />
              </svg>
            </div>
            <p className="hint phone-where">
              Scan it with the phone's camera. It opens <code>http://{link.ip}:{info?.port}</code> with the key to get in.
              {clients > 0 ? ` ${clients} ${clients === 1 ? 'page is' : 'pages are'} connected now.` : ''}
            </p>
            <div className="phone-actions">
              <button type="button" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.newLanLink())} title="Every device using the current link is disconnected">
                New link
              </button>
            </div>
          </>
        )}
        <ul className="hint phone-notes">
          <li>Whoever has the link controls your sessions as you do here. Keep it to yourself; <b>New link</b> disconnects every device that has the old one.</li>
          <li>The connection is protected only by your network's own encryption: use it on your own Wi-Fi, and switch it off elsewhere.</li>
          <li>
            If the phone shows a blank page or cannot connect, this computer's firewall is blocking Node.js: allow it on private networks. Windows asks only once; if that was
            refused, a Block rule for node.exe stays in its firewall's inbound rules.
          </li>
          <li>On the phone, browsers keep notifications and the clipboard for secure addresses, so those two are not available there.</li>
        </ul>
        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
