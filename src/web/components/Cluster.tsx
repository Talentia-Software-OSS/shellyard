import { useEffect, useState } from 'react';
import { stateCounts, type ChipState } from '../board.js';
import { limitDisplay, revLevel, zoneOf } from '../gauges.js';
import { setView, useStore } from '../store.js';
import { Dial } from './Dial.js';
import { GlyphMark } from './StatusGlyph.js';

/** The current time, refreshed often enough for countdowns shown to the minute. */
export function useNow(everyMs = 10_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** A small rev counter: how much a session's terminal is printing right now. */
export function Tachometer({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { activity, effects } = useStore();
  if (effects === 'off') return null;
  const level = revLevel(activity[sessionId] ?? 0);
  const angle = -90 + level * 180;
  return (
    <svg className="tacho" width="26" height="16" viewBox="0 0 40 24" aria-hidden="true">
      <path className="tacho-arc" d="M 4 21 A 16 16 0 0 1 36 21" />
      <path className="tacho-red" d="M 31.3 9.7 A 16 16 0 0 1 36 21" />
      <line className={effects === 'full' ? 'tacho-needle tacho-needle-live' : 'tacho-needle'} x1="20" y1="21" x2="20" y2="7" style={{ transform: `rotate(${angle}deg)` }} />
    </svg>
  );
}

/** The two plan limits, weekly first, then the 5-hour one on the yellow face. Opens usage. */
function Limits(): React.JSX.Element {
  const { usage, effects } = useStore();
  const now = useNow();
  const limits = usage?.limits ?? { fiveHour: null, sevenDay: null, readAt: null };
  const five = limitDisplay(limits.fiveHour, limits.readAt, now);
  const seven = limitDisplay(limits.sevenDay, limits.readAt, now);
  const text = (d: typeof five): string => (d.state === 'ok' ? `${d.pct}%` : 'no data');
  return (
    <button
      type="button"
      className={five.state === 'ok' || seven.state === 'ok' ? 'cluster-limits' : 'cluster-limits stale'}
      title={five.age ? `Plan limits, read ${five.age}. Open usage` : 'Plan limits: no reading yet. Open usage'}
      onClick={() => setView({ kind: 'usage' })}
    >
      <span className="cluster-dials">
        {effects !== 'off' && <Dial compact size={30} pct={seven.pct} dead={seven.state !== 'ok'} zone={zoneOf(seven.pct)} label="Weekly limit" valueText={text(seven)} />}
        <span className={`cluster-reading zone-text-${seven.state === 'ok' ? zoneOf(seven.pct) : 'none'}`}>
          <span className="cluster-caption">Weekly</span>
          <span className="cluster-figure">{text(seven)}</span>
        </span>
        {effects !== 'off' && <Dial compact hero size={30} pct={five.pct} dead={five.state !== 'ok'} zone={zoneOf(five.pct)} label="5-hour limit" valueText={text(five)} />}
        <span className={`cluster-reading zone-text-${five.state === 'ok' ? zoneOf(five.pct) : 'none'}`}>
          <span className="cluster-caption">5-hour</span>
          <span className="cluster-figure">{text(five)}</span>
        </span>
      </span>
    </button>
  );
}

const CHIPS: Array<{ glyph: ChipState; one: string; many: string; always: boolean }> = [
  { glyph: 'needs', one: 'needs you', many: 'need you', always: true },
  { glyph: 'finished', one: 'finished', many: 'finished', always: false },
  { glyph: 'working', one: 'working', many: 'working', always: true },
  { glyph: 'idle', one: 'idle', many: 'idle', always: true },
];

/**
 * How many sessions are in each state, as chips that show only those terminals. The chip of the
 * state shown is pressed, and pressing it again shows them all. "Finished" only when there are some.
 */
function StatusChips(): React.JSX.Element {
  const { sessions, steady, view } = useStore();
  const counts = stateCounts(sessions, steady);
  const current = view.kind === 'grid' ? view.stateFilter : undefined;
  return (
    <ul className="chips" aria-label="Sessions by state">
      {CHIPS.filter((c) => c.always || counts[c.glyph] > 0 || current === c.glyph).map((c) => {
        const n = counts[c.glyph];
        const label = `${n} ${n === 1 ? c.one : c.many}`;
        const pressed = current === c.glyph;
        const storyFilter = view.kind === 'grid' ? view.storyFilter : undefined;
        return (
          <li key={c.glyph}>
            <button
              type="button"
              className={`chip chip-${c.glyph}${n > 0 ? ' chip-lit' : ''}${pressed ? ' chip-pressed' : ''}`}
              aria-pressed={pressed}
              title={pressed ? 'Show all terminals' : `Show only the terminals that are ${c.glyph === 'needs' ? 'waiting for you' : c.many}`}
              onClick={() => setView({ kind: 'grid', storyFilter, stateFilter: pressed ? undefined : c.glyph })}
            >
              <GlyphMark glyph={c.glyph} size={12} />
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The instruments in the header, present on every view: plan limits and sessions by state. */
export function Cluster(): React.JSX.Element {
  return (
    <div className="cluster">
      <Limits />
      <StatusChips />
    </div>
  );
}
