interface IconProps {
  size?: number;
}

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function BoardIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </Svg>
  );
}

export function AttentionIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Svg>
  );
}

export function TerminalsIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Svg>
  );
}

export function ConversationsIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z" />
    </Svg>
  );
}

export function SchedulesIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

export function UsageIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </Svg>
  );
}

export function NewSessionIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </Svg>
  );
}

export function NewAreaIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="M12 11v4M10 13h4" />
    </Svg>
  );
}

export function SidebarIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Svg>
  );
}

/** A phone: phone access is on. */
export function PhoneIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </Svg>
  );
}

/** Three lines: opens the menu on a phone. */
export function MenuIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Svg>
  );
}

/** A magnifier: find and jump. */
export function SearchIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </Svg>
  );
}

/** Three sliders: the settings of the page. */
export function SettingsIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </Svg>
  );
}

/** Three dots: more actions. */
export function MoreIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  );
}

/** A shield: what stays on this computer. */
export function LocalIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    </Svg>
  );
}
