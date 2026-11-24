import { useEffect, useState } from 'react';
import { titleFor } from './attention.js';
import { AnswerQueue } from './components/AnswerQueue.js';
import { BoardView } from './components/BoardView.js';
import { Cluster } from './components/Cluster.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ConversationsView } from './components/ConversationsView.js';
import { DigestBanner, FocusSwitch } from './components/FocusSwitch.js';
import { SchedulesView } from './components/SchedulesView.js';
import { SettingsMenu } from './components/SettingsMenu.js';
import { ErrorNotices, RecentErrorsDialog } from './components/ErrorNotices.js';
import { StoryDialog } from './components/StoryDialog.js';
import { TicketDialog } from './components/TicketDialog.js';
import { UsageView } from './components/UsageView.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { Sidebar } from './components/Sidebar.js';
import { MenuIcon, PhoneIcon, SearchIcon } from './components/icons.js';
import { PhoneDialog } from './components/PhoneDialog.js';
import { onPhoneLink } from './phone.js';
import { SingleTerminal, TerminalsGrid } from './components/TerminalsGrid.js';
import { useEscape } from './escape.js';
import { paletteKey } from './palette.js';
import { selectCounts } from './selectors.js';
import { useStore } from './store.js';

export function App(): React.JSX.Element {
  const { sessions, stories, view, connection, lan } = useStore();
  const [phoneDialog, setPhoneDialog] = useState(false);
  const [dialog, setDialog] = useState<{ storyId?: string } | null>(null);
  const [palette, setPalette] = useState(false);
  const [areaDialog, setAreaDialog] = useState(false);
  const [ticketDialog, setTicketDialog] = useState(false);
  const [errorsDialog, setErrorsDialog] = useState(false);
  // The sidebar as a drawer, on a phone: opened from the header, closed by going somewhere.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [view]);
  // On the Escape stack, so that a dialog opened from the drawer (New area, a launcher) closes
  // first and alone.
  useEscape(() => setMenuOpen(false), menuOpen);
  const newSession = (storyId?: string): void => {
    setMenuOpen(false);
    setDialog({ storyId });
  };
  const filter = view.kind === 'attention' || view.kind === 'grid' ? view.storyFilter : undefined;
  const filterName = filter === undefined ? '' : filter === null ? 'No area' : (stories.find((s) => s.id === filter)?.name ?? '');
  const heading = view.kind === 'board' ? 'Board' : view.kind === 'attention' ? 'Needs attention' : view.kind === 'usage' ? 'Usage' : view.kind === 'conversations' ? 'Conversations' : view.kind === 'schedules' ? 'Schedules' : 'Terminals';
  const counts = selectCounts(sessions);

  useEffect(() => {
    document.title = titleFor(counts.attention);
  }, [counts.attention]);

  // Ctrl K opens the palette, except in a terminal (where it cuts the line); Ctrl Shift K from
  // anywhere. Caught on the way down, before a terminal sees the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inTerminal = document.activeElement?.closest('.xterm') != null;
      if (!paletteKey(e, inTerminal)) return;
      e.preventDefault();
      e.stopPropagation();
      setPalette(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // On a phone, the way back is the QR code on the computer, not a command.
  if (connection === 'unauthorized') {
    return onPhoneLink() ? (
      <main className="down">
        <h1>This link no longer opens ShellYard</h1>
        <p>A new link was made on the computer. Scan its QR code again: on the computer, the sliders button at the right of the header, then Phone access…</p>
      </main>
    ) : (
      <main className="down">
        <h1>Open ShellYard from a terminal</h1>
        <p>
          Run <code>shellyard</code> in a terminal: it opens this page with the access it needs.
        </p>
      </main>
    );
  }

  if (connection === 'down') {
    return onPhoneLink() ? (
      <main className="down">
        <h1>The computer cannot be reached</h1>
        <p>Phone access may be switched off, or the computer asleep or on another network. This page reconnects by itself.</p>
      </main>
    ) : (
      <main className="down">
        <h1>ShellYard is not running</h1>
        <p>
          Run <code>shellyard</code> in a terminal to start it. This page reconnects by itself.
        </p>
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar onNewSession={newSession} drawerOpen={menuOpen} onCloseDrawer={() => setMenuOpen(false)} />
      {menuOpen && <div className="drawer-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <main className="main">
        <header className="topbar">
          <button type="button" className="icon menu-toggle" aria-label="Open the menu" aria-controls="sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <MenuIcon size={22} />
          </button>
          <h1>
            {heading}
            {filterName && <span className="heading-filter">, {filterName}</span>}
          </h1>
          <button type="button" className="palette-open" aria-keyshortcuts="Control+K" onClick={() => setPalette(true)} aria-label="Jump to a session, area, ticket or run a command">
            <SearchIcon />
            <span>Jump to a session, area, ticket or run a command</span>
            <kbd className="key">Ctrl K</kbd>
          </button>
          <Cluster />
          {lan?.enabled && (
            <button
              type="button"
              className="phone-chip"
              onClick={() => setPhoneDialog(true)}
              title="Phone access is on: devices on this network with the link can open ShellYard"
              aria-label={`Phone access is on, ${lan.clients} connected`}
            >
              <PhoneIcon size={18} />
              <span className="phone-chip-text">{lan.clients > 0 ? `${lan.clients} connected` : 'Phone access'}</span>
            </button>
          )}
          <FocusSwitch />
          <SettingsMenu onRecentErrors={() => setErrorsDialog(true)} onPhoneAccess={() => setPhoneDialog(true)} />
        </header>
        {connection !== 'open' && (
          <div className="banner" role="status">
            {connection === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
          </div>
        )}
        <DigestBanner />
        <div className="content">
          {view.kind === 'board' && <BoardView onNewSession={(storyId) => setDialog({ storyId })} />}
          {view.kind === 'attention' && <AnswerQueue storyFilter={view.storyFilter} />}
          {view.kind === 'grid' && <TerminalsGrid storyFilter={view.storyFilter} />}
          {view.kind === 'usage' && <UsageView />}
          {view.kind === 'conversations' && <ConversationsView />}
          {view.kind === 'schedules' && <SchedulesView />}
          {view.kind === 'single' && <SingleTerminal key={view.id} id={view.id} />}
        </div>
      </main>
      {dialog && <NewSessionDialog initialStoryId={dialog.storyId} onClose={() => setDialog(null)} />}
      {areaDialog && <StoryDialog onClose={() => setAreaDialog(false)} />}
      {ticketDialog && <TicketDialog onClose={() => setTicketDialog(false)} />}
      {errorsDialog && <RecentErrorsDialog onClose={() => setErrorsDialog(false)} />}
      {phoneDialog && <PhoneDialog onClose={() => setPhoneDialog(false)} />}
      <ErrorNotices onShowAll={() => setErrorsDialog(true)} />
      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onNewSession={() => setDialog({})}
          onNewArea={() => setAreaDialog(true)}
          onTicket={() => setTicketDialog(true)}
        />
      )}
    </div>
  );
}
