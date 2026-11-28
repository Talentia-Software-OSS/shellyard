import { describe, expect, it } from 'vitest';
import { paletteKey, rankItems, scoreMatch } from '../../src/web/palette.js';

const item = (id: string, title: string, keywords = '') => ({ id, title, keywords });

describe('scoreMatch', () => {
  it('finds every word of the query, in any order', () => {
    expect(scoreMatch('Slot PROJ-7911 e PROJ-7912', 'proj 79')).not.toBeNull();
    expect(scoreMatch('Slot PROJ-7911 e PROJ-7912', '7912 slot')).not.toBeNull();
    expect(scoreMatch('Slot PROJ-7911', 'release')).toBeNull();
  });

  it('accepts the letters of a word in order, with gaps', () => {
    expect(scoreMatch('Release notes draft', 'rlsnt')).not.toBeNull();
    expect(scoreMatch('Release notes draft', 'tfard')).toBeNull();
  });

  it('ranks a word that starts with the query above one that only contains it, and both above scattered letters', () => {
    const start = scoreMatch('Terminals', 'term')!;
    const inside = scoreMatch('Determine', 'term')!;
    const scattered = scoreMatch('The error message', 'term')!;
    expect(start).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
  });

  it('matches anything with an empty query', () => {
    expect(scoreMatch('x', '  ')).toBe(0);
  });
});

describe('rankItems', () => {
  const items = [item('a', 'New session'), item('b', 'Slot PROJ-7911 e PROJ-7912', 'waiting'), item('c', 'Open ~/repos/project in VS Code'), item('d', 'Usage')];

  it('keeps the given order for an empty query', () => {
    expect(rankItems(items, '').map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps only what matches, the best first, searching the keywords too', () => {
    expect(rankItems(items, 'proj').map((i) => i.id)).toEqual(['b', 'c']);
    expect(rankItems(items, 'waiting').map((i) => i.id)).toEqual(['b']);
  });

  it('stops at the limit', () => {
    expect(rankItems(items, '', 2)).toHaveLength(2);
  });
});

describe('paletteKey', () => {
  const k = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>, inTerminal = false) =>
    paletteKey({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...over }, inTerminal);

  it('opens with Ctrl K or Cmd K outside a terminal', () => {
    expect(k({})).toBe(true);
    expect(k({ key: 'K' })).toBe(true);
    expect(k({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('leaves Ctrl K to a terminal, where it cuts the line; Ctrl Shift K opens from anywhere', () => {
    expect(k({}, true)).toBe(false);
    expect(k({ shiftKey: true, key: 'K' }, true)).toBe(true);
  });

  it('ignores other keys and Alt', () => {
    expect(k({ key: 'j' })).toBe(false);
    expect(k({ ctrlKey: false })).toBe(false);
    expect(k({ altKey: true })).toBe(false);
  });
});
