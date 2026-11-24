import { useEffect, useRef, useState } from 'react';
import type { Profile, Schedule, Story } from '../../shared/types.js';
import { api } from '../api.js';
import { LAUNCHER_DRAG } from '../drag.js';
import { dropLauncher } from '../drag-actions.js';
import { requestPermissionOnce } from '../notify.js';
import { selectCounts } from '../selectors.js';
import { isTypingTarget, launcherIndex } from '../shortcuts.js';
import { setView, useStore } from '../store.js';
import { useNarrow } from '../narrow.js';
import { dragSource, useDropTarget } from './drag-target.js';
import { LAUNCHERS_FOLDED_KEY, SESSIONS_FOLDED_KEY, SIDEBAR_FOLDED_KEY, readFlag, writeFlag } from '../sidebar-memory.js';
import { SidebarSessions } from './SidebarSessions.js';
import {
  AttentionIcon,
  BoardIcon,
  ConversationsIcon,
  LocalIcon,
  NewAreaIcon,
  NewSessionIcon,
  SchedulesIcon,
  SidebarIcon,
  TerminalsIcon,
  UsageIcon,
} from './icons.js';
import { ColorDot } from './SessionBits.js';
import { ProfileDialog } from './ProfileDialog.js';
import { StoryDialog } from './StoryDialog.js';

const report = (e: unknown): void => window.alert((e as Error).message);

/** Joins the class names that are set. */
const classes = (...names: Array<string | false | null | undefined>): string | undefined => names.filter(Boolean).join(' ') || undefined;

/** Launchers past the ninth have no shortcut. */
const SHORTCUTS = 9;

/** A launcher: click (or Alt and its number) to start it, drag to reorder the launchers. */
function LauncherRow({ profile: p, shortcut, onLaunch, onEdit }: { profile: Profile; shortcut: number | null; onLaunch: (p: Profile) => void; onEdit: (id: string) => void }): React.JSX.Element {
  const { dropClass, dropProps } = useDropTarget({ [LAUNCHER_DRAG]: { placed: true, targetId: p.id, onDrop: (id, place) => dropLauncher(id, p.id, place) } });
  return (
    <li className={classes('profile-row', dropClass)} {...dropProps}>
      <button
        type="button"
        className="profile"
        title={`Start ${p.name}${shortcut ? ` (Alt ${shortcut})` : ''}`}
        aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
        {...dragSource(LAUNCHER_DRAG, p.id)}
        onClick={() => onLaunch(p)}
      >
        <ColorDot color={p.color} />
        <span className="profile-name">{p.name}</span>
        {shortcut && <kbd className="shortcut">Alt {shortcut}</kbd>}
      </button>
      <button type="button" className="icon" title="Edit this launcher: name, start folder and terminal look" aria-label={`Edit the launcher ${p.name}`} onClick={() => onEdit(p.id)}>
        ✎
      </button>
    </li>
  );
}

/** "next 18:00" for a run within a day, else how many schedules are on; null when none is. */
function scheduleNote(schedules: Schedule[], now: number): string | null {
  const on = schedules.filter((s) => s.enabled);
  if (on.length === 0) return null;
  const next = Math.min(...on.map((s) => s.nextRunAt ?? Number.POSITIVE_INFINITY));
  if (Number.isFinite(next) && next - now < 24 * 3_600_000) {
    return `next ${new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${on.length} on`;
}

/** Where to go, the sessions under their areas, and what to start. */
export function Sidebar({ onNewSession, drawerOpen = false, onCloseDrawer }: { onNewSession: (storyId?: string) => void; drawerOpen?: boolean; onCloseDrawer?: () => void }): React.JSX.Element {
  const { sessions, schedules, view, meta, lan } = useStore();
  // On a phone the sidebar is a drawer over the page: always unfolded, and its toggle closes it.
  const narrow = useNarrow();
  const counts = selectCounts(sessions);
  const [railFolded, setRailFolded] = useState(() => readFlag(SIDEBAR_FOLDED_KEY));
  const [sessionsFolded, setSessionsFolded] = useState(() => readFlag(SESSIONS_FOLDED_KEY));
  const [launchersFolded, setLaunchersFolded] = useState(() => readFlag(LAUNCHERS_FOLDED_KEY));
  const [storyDialog, setStoryDialog] = useState<{ story?: Story } | null>(null);
  const [profileDialog, setProfileDialog] = useState<string | null>(null);
  const editedProfile = meta.profiles.find((p) => p.id === profileDialog);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const storyFilter = view.kind === 'grid' ? view.storyFilter : undefined;

  const flip = (current: boolean, set: (v: boolean) => void, key: string): void => {
    set(!current);
    writeFlag(key, !current);
  };

  const launch = (p: Profile): void => {
    if (p.kind === 'claude') requestPermissionOnce();
    api
      .createSession({ profileId: p.id })
      .then((s) => setView({ kind: 'single', id: s.id }))
      .catch(report);
  };

  // Alt+1 to Alt+9 start the launchers, unless the keys are being typed somewhere.
  const latest = useRef({ profiles: meta.profiles, launch });
  latest.current = { profiles: meta.profiles, launch };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { profiles, launch: start } = latest.current;
      const i = launcherIndex(e, Math.min(profiles.length, SHORTCUTS), isTypingTarget(document.activeElement));
      if (i === null) return;
      e.preventDefault();
      start(profiles[i]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const schedulesNote = scheduleNote(schedules, Date.now());
  const nav = (active: boolean): string => (active ? 'nav active' : 'nav');

  const folded = railFolded && !narrow;

  return (
    <aside id="sidebar" className={classes('sidebar', folded && 'folded', narrow && drawerOpen && 'drawer-open')} aria-hidden={narrow && !drawerOpen ? true : undefined} inert={narrow && !drawerOpen ? true : undefined}>
      <div className="sidebar-top">
        <button
          type="button"
          className="icon sidebar-toggle"
          aria-expanded={narrow ? drawerOpen : !folded}
          title={narrow ? 'Close the menu' : folded ? 'Unfold the sidebar' : 'Fold the sidebar'}
          aria-label={narrow ? 'Close the menu' : folded ? 'Unfold the sidebar' : 'Fold the sidebar'}
          onClick={() => (narrow ? onCloseDrawer?.() : flip(railFolded, setRailFolded, SIDEBAR_FOLDED_KEY))}
        >
          <SidebarIcon size={18} />
        </button>
        <div className="brand">ShellYard</div>
      </div>

      <nav>
        <button type="button" title="Board" aria-label="Board" aria-current={view.kind === 'board' ? 'page' : undefined} className={nav(view.kind === 'board')} onClick={() => setView({ kind: 'board' })}>
          <BoardIcon />
          <span className="nav-label">Board</span>
        </button>
        <button type="button" title="Needs attention" aria-label={counts.attention > 0 ? `Needs attention, ${counts.attention}` : 'Needs attention'} aria-current={view.kind === 'attention' ? 'page' : undefined} className={nav(view.kind === 'attention')} onClick={() => setView({ kind: 'attention' })}>
          <AttentionIcon />
          <span className="nav-label">Needs attention</span>
          {counts.attention > 0 && <span className="count">{counts.attention}</span>}
        </button>
        <button type="button" title="Terminals" aria-label={`Terminals, ${sessions.length}`} aria-current={view.kind === 'grid' && storyFilter === undefined ? 'page' : undefined} className={nav(view.kind === 'grid' && storyFilter === undefined)} onClick={() => setView({ kind: 'grid' })}>
          <TerminalsIcon />
          <span className="nav-label">Terminals</span>
          <span className="count quiet">{sessions.length}</span>
        </button>
        <button type="button" title="Conversations" aria-label="Conversations" aria-current={view.kind === 'conversations' ? 'page' : undefined} className={nav(view.kind === 'conversations')} onClick={() => setView({ kind: 'conversations' })}>
          <ConversationsIcon />
          <span className="nav-label">Conversations</span>
        </button>
        <button type="button" title="Schedules" aria-label={schedulesNote ? `Schedules, ${schedulesNote}` : 'Schedules'} aria-current={view.kind === 'schedules' ? 'page' : undefined} className={nav(view.kind === 'schedules')} onClick={() => setView({ kind: 'schedules' })}>
          <SchedulesIcon />
          <span className="nav-label">Schedules</span>
          {schedulesNote && <span className="count quiet note">{schedulesNote}</span>}
        </button>
        <button type="button" title="Usage" aria-label="Usage" aria-current={view.kind === 'usage' ? 'page' : undefined} className={nav(view.kind === 'usage')} onClick={() => setView({ kind: 'usage' })}>
          <UsageIcon />
          <span className="nav-label">Usage</span>
        </button>
      </nav>

      <div className="new-buttons">
        <button type="button" className="start" title="New session" aria-label="New session" onClick={() => onNewSession()}>
          <span className="start-ring start-full" aria-hidden="true">
            <span className="start-core" />
          </span>
          <span className="start-compact">
            <NewSessionIcon />
          </span>
          <span className="start-label">New session</span>
        </button>
        <button type="button" className="new-story" onClick={() => setStoryDialog({})}>
          <NewAreaIcon />
          <span>New area</span>
        </button>
      </div>

      <h2 className="section-title">
        <button type="button" className="section-toggle" aria-expanded={!sessionsFolded} onClick={() => flip(sessionsFolded, setSessionsFolded, SESSIONS_FOLDED_KEY)}>
          <span aria-hidden="true">{sessionsFolded ? '▸' : '▾'}</span> Sessions
        </button>
      </h2>
      {!sessionsFolded && <SidebarSessions onNewSession={onNewSession} onEditArea={(story) => setStoryDialog({ story })} />}

      <h2 className="section-title">
        <button type="button" className="section-toggle" aria-expanded={!launchersFolded} onClick={() => flip(launchersFolded, setLaunchersFolded, LAUNCHERS_FOLDED_KEY)}>
          <span aria-hidden="true">{launchersFolded ? '▸' : '▾'}</span> Launchers
        </button>
      </h2>
      {!launchersFolded && (
        <div className="launchers-section">
          {meta.profiles.length === 0 && <p className="hint">No launchers found.</p>}
          <ul className="profile-list">
            {meta.profiles.map((p, i) => (
              <LauncherRow key={p.id} profile={p} shortcut={i < SHORTCUTS ? i + 1 : null} onLaunch={launch} onEdit={setProfileDialog} />
            ))}
          </ul>
          <button type="button" className="icon add-launcher" title="New launcher" aria-label="New launcher" onClick={() => setCreatingProfile(true)}>
            +
          </button>
        </div>
      )}

      {lan?.enabled ? (
        // Not "local only" any more: say what is open, and to whom.
        <div className="local-note">
          <p className="local-title">
            <LocalIcon size={14} /> Local network
          </p>
          <p className="hint">
            Phone access on · HTTPS on port {lan.port} for devices with the link · ShellYard sends nothing out
          </p>
        </div>
      ) : (
        <div className="local-note">
          <p className="local-title">
            <LocalIcon size={14} /> Local only
          </p>
          <p className="hint">127.0.0.1 · a new token at every start · ShellYard sends nothing out</p>
        </div>
      )}
      <p className="powered-by">Powered by Talentia Software</p>

      {storyDialog && <StoryDialog story={storyDialog.story} onClose={() => setStoryDialog(null)} />}
      {editedProfile && <ProfileDialog profile={editedProfile} onClose={() => setProfileDialog(null)} />}
      {creatingProfile && <ProfileDialog onClose={() => setCreatingProfile(false)} />}
    </aside>
  );
}
