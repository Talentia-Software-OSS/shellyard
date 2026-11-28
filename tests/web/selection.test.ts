import { describe, expect, it } from 'vitest';
import { isSelectGesture, pruneSelection, sendReport, toggleSelected } from '../../src/web/selection.js';

describe('toggleSelected', () => {
  it('adds a session at the end, or takes it out', () => {
    expect(toggleSelected([], 'a')).toEqual(['a']);
    expect(toggleSelected(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelected(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('pruneSelection', () => {
  it('drops the sessions that no longer exist, keeping the same list when nothing changed', () => {
    const sel = ['a', 'b', 'c'];
    expect(pruneSelection(sel, new Set(['a', 'c']))).toEqual(['a', 'c']);
    expect(pruneSelection(sel, new Set(['a', 'b', 'c']))).toBe(sel);
  });
});

describe('isSelectGesture', () => {
  const ev = (over: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });
  it('is a click with Shift, Ctrl or Cmd', () => {
    expect(isSelectGesture(ev({ shiftKey: true }))).toBe(true);
    expect(isSelectGesture(ev({ ctrlKey: true }))).toBe(true);
    expect(isSelectGesture(ev({ metaKey: true }))).toBe(true);
  });
  it('is not a plain click, nor one with Alt', () => {
    expect(isSelectGesture(ev())).toBe(false);
    expect(isSelectGesture(ev({ altKey: true, shiftKey: true }))).toBe(false);
  });
});

describe('sendReport', () => {
  const names = new Map([
    ['a', 'Worktree PROJ'],
    ['b', 'Release notes'],
    ['c', 'PROJ-8139 hotfix'],
  ]);
  it('says how many took the prompt', () => {
    expect(sendReport([{ id: 'a', outcome: 'sent' }, { id: 'b', outcome: 'sent' }], names)).toBe('Sent to 2 sessions.');
    expect(sendReport([{ id: 'a', outcome: 'sent' }], names)).toBe('Sent to 1 session.');
  });
  it('names the ones that did not, and why', () => {
    expect(
      sendReport(
        [
          { id: 'a', outcome: 'sent' },
          { id: 'b', outcome: 'busy' },
          { id: 'c', outcome: 'not-claude' },
          { id: 'z', outcome: 'missing' },
        ],
        names,
      ),
    ).toBe('Sent to 1 of 4. Not sent: Release notes (busy: it is working or waiting on a question), PROJ-8139 hotfix (not a Claude Code session), a closed session.');
  });
});
