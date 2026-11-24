import type { ErrorReport, SessionInfo } from '../shared/types.js';
import { reasonLabel } from './attention.js';

let asked = false;

/** What the desktop app's window offers the page (see desktop/preload.cjs); absent in a browser. */
interface DesktopBridge {
  showWindow(): void;
}

/**
 * Brings ShellYard to the front after a click on one of its notifications. In a browser the tab
 * is focused. In the desktop app the window may be hidden in the tray or minimised, which the
 * page cannot undo by itself: the app is asked to show it.
 */
export function bringToFront(w: Window & { shellyardDesktop?: DesktopBridge } = window): void {
  try {
    w.shellyardDesktop?.showWindow();
  } catch {
    // An older desktop app without the bridge: focusing is all there is.
  }
  w.focus();
}

/** Where a click on a session's notification leads: that session, or the board if it is gone. */
export function viewForSession(sessions: SessionInfo[], id: string): { kind: 'single'; id: string } | { kind: 'board' } {
  return sessions.some((s) => s.id === id) ? { kind: 'single', id } : { kind: 'board' };
}

/**
 * What a click on a notification does. In a browser the default is left alone: it is the browser
 * that brings the notification's tab to the front, which `window.focus()` alone often cannot do
 * for a tab in the background or in another window. Only in the desktop app, where the app shows
 * its own window, is the default prevented.
 */
export function handleNotificationClick(
  e: Pick<Event, 'preventDefault'>,
  onClick: () => void,
  w: Window & { shellyardDesktop?: DesktopBridge } = window,
): void {
  if (w.shellyardDesktop) e.preventDefault();
  bringToFront(w);
  onClick();
}

/** Shows a notification that, when clicked, brings ShellYard to the front and runs `onClick`. */
function show(title: string, options: NotificationOptions, onClick: () => void): void {
  let n: Notification;
  try {
    n = new Notification(title, options);
  } catch {
    // Android browsers have the Notification API on a secure page (phone access) but refuse a
    // page's own notifications: there is nothing to show, and nothing else must break.
    return;
  }
  n.onclick = (e) => {
    handleNotificationClick(e, onClick);
    n.close();
  };
}

/** Asks for notification permission once, at a moment the user has just done something. */
export function requestPermissionOnce(): void {
  if (asked || typeof Notification === 'undefined') return;
  asked = true;
  if (Notification.permission === 'default') void Notification.requestPermission();
}

/**
 * Shows a system notification, but only when the page is not what the user is looking at.
 * The system plays its own sound with a notification unless told not to: with Sound off it
 * is told not to.
 */
export function notify(s: SessionInfo, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  show(s.name, { body: reasonLabel(s), tag: `shellyard-${s.id}`, silent: !sound }, onClick);
}

/**
 * A scheduled run that has waited on the user too long. Shown even when the page is in view:
 * it is a reminder, after the first notification of the wait went unanswered.
 */
export function notifyStuck(name: string, body: string, tag: string, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  show(name, { body, tag: `shellyard-stuck-${tag}`, silent: !sound }, onClick);
}

/** The digest at the end of a focus: one notification, if the page is not in view. */
export function notifyDigest(text: string, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  show('Focus ended', { body: text, tag: 'shellyard-focus-digest', silent: !sound }, onClick);
}

/** An unexpected error, with where its report is: one notification, if the page is not in view. */
export function notifyError(report: ErrorReport, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  const title = report.source === 'page' ? 'ShellYard: the page hit an error' : 'ShellYard hit an error';
  show(title, { body: `${report.message}\nReport: ${report.file}`, tag: `shellyard-error-${report.id}`, silent: !sound }, onClick);
}
