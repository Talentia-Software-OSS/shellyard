import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { TerminalBackground, TerminalFont } from '../../shared/types.js';
import { backgroundUrl } from '../api.js';
import { getSocket, getState, onThemeChange } from '../store.js';
import { hostStyle, terminalFont, terminalLook } from '../terminal-look.js';
import { HIGHLIGHT_LIMIT, isSearchKey, isValidPattern, searchCountText } from '../terminal-search.js';
import { attachTouchScroll } from '../touch-scroll.js';

const RESIZE_DEBOUNCE_MS = 100;

/** The marks of the matches; the addon wants #RRGGBB colours. */
const SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBorder: '#e8a33d',
  matchOverviewRuler: '#e8a33d',
  activeMatchBackground: '#e8a33d',
  activeMatchBorder: '#ffd27a',
  activeMatchColorOverviewRuler: '#ffd27a',
};

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * The real terminal of one session. It attaches on mount (and again after a reconnect),
 * receives the restored screen followed by live output, and sends back keystrokes and its
 * size. A session must be mounted in only one place at a time within a page.
 *
 * A session has one size, and the program in it draws for that size. The same session can be
 * on screen in two pages (two tabs, two windows) whose terminals would fit different sizes.
 * So one page decides and the others follow: a page claims the size when it is the one being
 * used (it is shown, its terminal is focused, its own layout changes), and a page that sees
 * the session take another size sets its terminal to that size instead of its own fit. A
 * terminal drawn at another size than the program believes shows its text out of place, so
 * the size comes with the output, and is taken at the point of the output where it changed.
 */
export function TerminalView(props: {
  sessionId: string;
  autoFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
  /** What is behind the text; null or absent follows the theme. */
  background?: TerminalBackground | null;
  /** The font and text size; null or absent is the default. */
  font?: TerminalFont | null;
  /** The size the session has on the server, which another page may have set. */
  size?: { cols: number; rows: number };
}): React.JSX.Element {
  const { sessionId, autoFocus } = props;
  const host = useRef<HTMLDivElement>(null);
  const onFocusChange = useRef(props.onFocusChange);
  onFocusChange.current = props.onFocusChange;
  const background = props.background ?? null;
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  /** Applies the current background and theme to the terminal that is open. */
  const applyLook = useRef<() => void>(() => undefined);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const font = props.font ?? null;
  const fontRef = useRef(font);
  fontRef.current = font;
  /** Applies the current font to the terminal that is open, and fits it again. */
  const applyFont = useRef<() => void>(() => undefined);
  const sizeRef = useRef(props.size);
  sizeRef.current = props.size;
  const searchAddon = useRef<SearchAddon | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null);
  const invalid = !isValidPattern(query, regex);
  /** Opens the search bar, or puts the cursor back in it when it is open. */
  const openSearch = useRef<() => void>(() => undefined);
  openSearch.current = () => {
    // Selected text is what the user most likely wants to find.
    const selected = terminal.current?.getSelection() ?? '';
    if (selected && !selected.includes('\n')) setQuery(selected);
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  };

  /** Goes to the next (or previous) match; "incremental" keeps the current one if it still matches. */
  const find = (direction: 'next' | 'previous', incremental = false): void => {
    const search = searchAddon.current;
    if (!search) return;
    if (!query || !isValidPattern(query, regex)) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    const options: ISearchOptions = { caseSensitive, regex, incremental, decorations: SEARCH_DECORATIONS };
    const found = direction === 'next' ? search.findNext(query, options) : search.findPrevious(query, options);
    if (!found) setResult({ resultIndex: -1, resultCount: 0 });
  };

  // Typing, or changing an option, searches again from where the terminal is.
  useEffect(() => {
    if (searchOpen) find('next', true);
  }, [query, caseSensitive, regex, searchOpen]);

  const closeSearch = (): void => {
    searchAddon.current?.clearDecorations();
    setResult(null);
    setSearchOpen(false);
    terminal.current?.focus();
  };

  // A stored image is fetched once and drawn behind the terminal, under its veil.
  useEffect(() => {
    let current = true;
    setImageUrl(null);
    if (background?.image) {
      backgroundUrl(background.image).then(
        (url) => current && setImageUrl(url),
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [background?.image]);

  useEffect(() => {
    applyLook.current();
  }, [background?.color, background?.image, background?.veil]);

  useEffect(() => {
    applyFont.current();
  }, [font?.family, font?.size]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const socket = getSocket();
    // Programs colour their output for a dark terminal. On the light theme the terminal is
    // light too, and xterm is asked to keep every colour readable against it: it darkens a
    // foreground that would otherwise be pale on pale.
    // A background chosen for this terminal comes before the theme: a colour, or an image
    // behind a transparent terminal.
    const look = (): { theme: { background: string; foreground: string; cursor: string; selectionBackground: string }; minimumContrastRatio: number } => {
      const theme = getState().theme;
      const chosen = terminalLook(backgroundRef.current, theme, { termBg: cssVar('--term-bg', '#0c0d10'), termFg: cssVar('--term-fg', '#d7dae0') });
      return {
        theme: {
          background: chosen.background,
          foreground: chosen.foreground,
          cursor: cssVar('--accent', '#e5484d'),
          selectionBackground: chosen.lightText ? '#3d4f6b' : '#b6d0f7',
        },
        minimumContrastRatio: chosen.minimumContrastRatio,
      };
    };
    const term = new Terminal({
      ...terminalFont(fontRef.current),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      // Needed for an image to show through; it has to be decided when the terminal is made.
      allowTransparency: true,
      ...look(),
    });
    applyLook.current = () => {
      const next = look();
      term.options.theme = next.theme;
      term.options.minimumContrastRatio = next.minimumContrastRatio;
    };
    const offTheme = onThemeChange(() => applyLook.current());
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
    term.loadAddon(search);
    const searchResults = search.onDidChangeResults((r) => setResult(r));
    searchAddon.current = search;
    terminal.current = term;
    term.open(el);

    const safeFit = (): void => {
      // A hidden container has no size; fitting then would shrink the terminal to nothing.
      if (el.clientWidth < 20 || el.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        // xterm can throw while its renderer is not ready yet; the next resize fits it.
      }
    };

    // The size this page last asked for, until the server's answer has come back.
    let asked: { cols: number; rows: number; at: number } | null = null;
    // What the last attach asked for: the snapshot that answers it is taken after the server
    // has dealt with it, so by then it is no longer on its way.
    let attachAsked: { cols: number; rows: number; at: number } | null = null;
    // Counts the snapshots: a size that was told before one is not for the screen it restores.
    let screen = 0;
    const ASKED_MS = 1500;
    // Whether this page is the one deciding the size. It stops being so when it takes a size
    // another page set, and then its own layout changing is no reason to take the size back:
    // drawing a terminal at a size that does not fit here can itself move the layout.
    let deciding = false;
    /** Makes the session the size that fits here. */
    const claim = (): void => {
      deciding = true;
      safeFit();
      const known = sizeRef.current;
      if (known && known.cols === term.cols && known.rows === term.rows) return;
      asked = { cols: term.cols, rows: term.rows, at: Date.now() };
      socket.send({ t: 'resize', id: sessionId, cols: term.cols, rows: term.rows });
    };
    /** Takes the size the session has taken, when it is not the one this page asked for. */
    const follow = (size: { cols: number; rows: number }): void => {
      if (size.cols < 2 || size.rows < 2) return;
      const ours = asked !== null && asked.cols === size.cols && asked.rows === size.rows;
      if (ours) asked = null;
      // An answer still on its way must not be undone by an older size arriving first.
      if (asked && Date.now() - asked.at < ASKED_MS) return;
      asked = null;
      if (size.cols === term.cols && size.rows === term.rows) return;
      // Taking the size this page asked for (a snapshot had it draw at another meanwhile) is
      // still deciding it; taking the size of another page is not.
      if (!ours) deciding = false;
      term.resize(size.cols, size.rows);
    };
    /**
     * Takes the size a snapshot was taken at, whatever this page asked for: the snapshot can
     * only be drawn at that size. Only a request made after the attach can still be on its way.
     */
    const restoreAt = (size: { cols: number; rows: number }): void => {
      if (size.cols < 2 || size.rows < 2) return;
      const ours = asked !== null && asked.cols === size.cols && asked.rows === size.rows;
      const onItsWay = asked !== null && !ours && asked !== attachAsked;
      if (!onItsWay) asked = null;
      attachAsked = null;
      if (size.cols === term.cols && size.rows === term.rows) return;
      // Another page has set the size since: this one follows, and does not take it back.
      if (!ours && !onItsWay) deciding = false;
      term.resize(size.cols, size.rows);
    };

    const attach = (): void => {
      // A page nobody is looking at does not get to decide the size: it attaches as it is
      // and takes the size the session has.
      if (document.visibilityState === 'hidden') {
        socket.send({ t: 'attach', id: sessionId, cols: 0, rows: 0 });
        return;
      }
      deciding = true;
      safeFit();
      asked = { cols: term.cols, rows: term.rows, at: Date.now() };
      attachAsked = asked;
      socket.send({ t: 'attach', id: sessionId, cols: term.cols, rows: term.rows });
    };

    const unsubscribe = socket.subscribe(sessionId, (m) => {
      if (m.t === 'size') {
        // The size changes where it did in the output: what was printed before it is drawn at
        // the size it was printed for, and what comes after at the new one. Taking the size
        // at any other moment draws the program's repaint out of place, and it stays so.
        // A snapshot arriving before this is reached has its own size, a newer one.
        const told = screen;
        term.write('', () => {
          if (told === screen) follow(m);
        });
        return;
      }
      if (m.t === 'snapshot') {
        screen += 1;
        term.reset();
        // The snapshot is drawn at the size it was taken at.
        restoreAt(m);
      }
      term.write(m.data);
    });
    const offState = socket.onState((s) => {
      if (s === 'open') attach();
    });
    if (socket.state() === 'open') attach();

    const input = term.onData((data) => socket.send({ t: 'input', id: sessionId, data }));

    // Ctrl+C copies when there is a selection (otherwise it interrupts, as in any terminal),
    // and Ctrl+V is left to the browser so that its paste event reaches the terminal.
    // Ctrl+Shift+F (Cmd+F on a Mac) opens the search instead of reaching the program.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && isSearchKey(e)) {
        e.preventDefault();
        openSearch.current();
        return false;
      }
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (key === 'v') return false;
      return true;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const refit = claim;
    // Another font or size changes how many columns and rows fit: the session is told.
    applyFont.current = () => {
      const next = terminalFont(fontRef.current);
      if (term.options.fontFamily === next.fontFamily && term.options.fontSize === next.fontSize) return;
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      refit();
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (deciding) refit();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);

    const onFocusIn = (): void => {
      // The terminal being typed in is the one whose size counts.
      claim();
      onFocusChange.current?.(true);
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') claim();
    };
    document.addEventListener('visibilitychange', onVisible);
    const onFocusOut = (): void => onFocusChange.current?.(false);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    const offTouch = attachTouchScroll(el, term);
    if (autoFocus) term.focus();

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
      offTouch();
      input.dispose();
      applyLook.current = () => undefined;
      applyFont.current = () => undefined;
      offTheme();
      offState();
      searchResults.dispose();
      searchAddon.current = null;
      terminal.current = null;
      unsubscribe();
      socket.send({ t: 'detach', id: sessionId });
      term.dispose();
    };
  }, [sessionId, autoFocus]);

  const style = background?.color ? { background: background.color } : hostStyle(background, imageUrl);
  return (
    <div className="terminal-frame">
      <div className="terminal-host" ref={host} style={style} data-background={background?.image ? 'image' : background?.color ? 'color' : 'theme'} />
      {searchOpen && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            type="text"
            value={query}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            aria-invalid={invalid}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                find(e.shiftKey ? 'previous' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              } else if (isSearchKey(e)) {
                // The shortcut again selects what is typed, as browsers do.
                e.preventDefault();
                e.currentTarget.select();
              }
            }}
          />
          <span className="terminal-search-count" aria-live="polite">
            {searchCountText(query, result, invalid)}
          </span>
          <button type="button" className={caseSensitive ? 'on' : ''} aria-pressed={caseSensitive} title="Match case" onClick={() => setCaseSensitive((v) => !v)}>
            Aa
          </button>
          <button type="button" className={regex ? 'on' : ''} aria-pressed={regex} title="Regular expression" onClick={() => setRegex((v) => !v)}>
            .*
          </button>
          <button type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!query || invalid} onClick={() => find('previous')}>
            ↑
          </button>
          <button type="button" title="Next match (Enter)" aria-label="Next match" disabled={!query || invalid} onClick={() => find('next')}>
            ↓
          </button>
          <button type="button" title="Close (Escape)" aria-label="Close search" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
