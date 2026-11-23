# ShellYard

Run several Claude Code sessions and shells at once, in one browser page, and see at a glance
which of them is waiting for you.

ShellYard starts real terminal processes on your machine (PowerShell, bash, `claude`, anything else)
and shows them in a local web page. Each process is the same one you would get in a terminal
window: your profile, your PATH, your permissions. The page is its screen and keyboard.

![ShellYard: three Claude Code sessions ask for permission, they are answered from the queue with the keyboard, and they go back to work](https://raw.githubusercontent.com/Netrumble/shellyard/main/docs/media/shellyard-demo.gif)

> [!NOTE]
> **Is it safe?** ShellYard stays on your machine and is built so that nothing else can use it:
> - **Nothing leaves your PC.** The server listens on `127.0.0.1` only: no other computer can
>   reach it, and ShellYard itself sends nothing to the internet (the programs you run in it, such
>   as Claude Code, connect as they always do). The exceptions are yours to make: the desktop
>   app asks GitHub whether a newer version is out when you choose **Check for updates…**, or
>   once a day if you turn the automatic check on (it is off until you do); and
>   [Phone access](#phone-access), off until you switch it on, lets the devices of your local
>   network that have its link open the page.
> - **Only your page gets in.** Every request that does something needs a secret token, created
>   anew at each start; requests from other websites or other host names are refused.
> - **No cookies.** The token is never kept in a cookie, so it is never sent to anything else.
> - **The desktop app is locked down.** Its window cannot run code on your PC by itself, cannot
>   browse to other sites (links open in your browser), and stores no cookies.
> - **Your sessions run as you,** with your usual permissions, never more.
>
> Details, and what ShellYard does not protect against, in [Security](#security).

## Install

ShellYard comes in the browser or as a desktop app (see [Which one to pick](#which-one-to-pick)).
Every way needs Node.js 22 or later on PATH: the server that runs your sessions is a Node process.

### In the browser, from npm (Windows, macOS and Linux)

```
npm install -g @talentiaoss/shellyard
shellyard
```

ShellYard opens in your default browser. `npx @talentiaoss/shellyard` runs it without installing.

### As a desktop app, with the setup program (Windows)

1. Download `ShellYard-Setup-<version>.exe` from the
   [latest release](https://github.com/Talentia-Software-OSS/shellyard/releases/latest), with the
   `ShellYard-Setup-<version>.exe.sha256` beside it. To check the download, compare the two in
   PowerShell: `(Get-FileHash .\ShellYard-Setup-<version>.exe -Algorithm SHA256).Hash` must equal
   the first word of the `.sha256` file (case does not matter).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen says "Windows protected your
   PC": click **More info**, then **Run anyway**.
3. Pick the folder (the default is `%LOCALAPPDATA%\Programs\ShellYard`, no administrator rights
   needed) and finish. ShellYard is added to the Start menu and the desktop.

ShellYard then runs in its own window, with an icon in the notification area: closing the window
keeps it there, and it still tells you when a session needs you. To uninstall it, use **Settings →
Apps → Installed apps → ShellYard**. Uninstalling leaves your data in `~/.shellyard`.

### As a desktop app, with the disk image (macOS)

> [!IMPORTANT]
> **The first time, macOS refuses to open ShellYard** and says *"Apple could not verify
> ShellYard.app is free of malware that may harm your Mac or compromise your privacy"*. This is
> expected: the app is not signed with an Apple Developer ID certificate nor notarised by Apple
> yet, so macOS cannot vouch for it. It is not damaged. Allow it once, as shown in step 3; check the
> download against its checksum first if you want to be sure it is the published file.

1. Download `ShellYard-<version>-arm64.dmg` for Apple Silicon (M1 and later) or
   `ShellYard-<version>-x64.dmg` for an Intel Mac (Apple menu → About This Mac says which) from the
   [latest release](https://github.com/Talentia-Software-OSS/shellyard/releases/latest), with the
   `.dmg.sha256` beside it. To check the download, in Terminal, in the folder you downloaded them to:
   `shasum -a 256 -c ShellYard-<version>-<arch>.dmg.sha256` must print `OK`.
2. Open the disk image and drag ShellYard into Applications.
3. Allow it, in one of two ways:
   - **In Terminal** (quickest): remove the quarantine mark macOS puts on downloaded files, then open
     the app as usual:
     ```
     xattr -dr com.apple.quarantine /Applications/ShellYard.app
     ```
   - **In System Settings**: open ShellYard and close the warning with **Done**. Go to **System
     Settings → Privacy & Security**, scroll down to *"ShellYard.app was blocked to protect your
     Mac"*, press **Open Anyway** and confirm with your password or Touch ID. On recent macOS
     versions, right-click → Open no longer offers to open such an app: use one of these two ways.

   This is needed once per version: after an update, allow the new app again.

ShellYard then runs in its own window, with an icon in the menu bar: closing the window keeps it
there, and it still tells you when a session needs you; Cmd+Q quits it (the sessions keep running).
Opened from the Finder or the Dock, the app takes the PATH of your login shell (`$SHELL -il`), so
`node`, `claude` and `code` are found as in a terminal. To uninstall it, move it to the Bin; your
data stays in `~/.shellyard`.

### As a desktop app, from npm (Linux, macOS, or Windows from a terminal)

```
npm install -g @talentiaoss/shellyard-desktop
shellyard-desktop
```

This is the same desktop app as the Windows setup program and the macOS disk image, installed the
npm way. It is meant for Linux, where there is no installer, and for people who prefer to manage
their tools with npm.
The first install downloads Electron (about 100 MB). See [desktop/README.md](desktop/README.md).

### Which one to pick

| | `shellyard` (npm) | Setup program (`.exe`) | Disk image (`.dmg`) | `shellyard-desktop` (npm) |
|---|---|---|---|---|
| Where ShellYard shows | a tab in your browser | its own window | its own window | its own window |
| Icon in the notification area or menu bar, notifications when the window is closed | no | yes | yes | yes |
| Shortcuts | no | Start menu and desktop | Applications, Launchpad | no: start it with `shellyard-desktop` |
| Uninstall | `npm uninstall -g @talentiaoss/shellyard` | Settings → Apps | move it to the Bin | `npm uninstall -g @talentiaoss/shellyard-desktop` |
| Update | `npm update -g @talentiaoss/shellyard` | run the new setup program | replace the app with the new one | `npm update -g @talentiaoss/shellyard-desktop` |
| Systems | Windows, macOS, Linux | Windows | macOS (Apple Silicon and Intel) | Windows, macOS, Linux |
| Size | small | about 120 MB (includes Electron) | about 120 MB (includes Electron) | about 100 MB (downloads Electron) |

On Windows the setup program, and on a Mac the disk image, are the simplest choice for a desktop
window; `shellyard` alone is enough if a browser tab suits you.

All three are views of the same server: you can use them at once, and they show the same sessions.
Both desktop variants carry their own copy of the server, so you do not need to install `shellyard`
as well; install it only if you also want its commands (`shellyard status`, `shellyard stop`, …).

### Updates of the desktop app

**Check for updates…**, in the app's menu (the ShellYard menu on macOS, Help elsewhere) and in the
tray's, asks GitHub for the latest release. When a newer one is out, the app says so and offers to
download its installer for your system (the setup program, or the disk image for your Mac's
processor) in your browser, or to open the release page; install it as the first time. Your
sessions keep running meanwhile. The app never downloads nor installs anything by itself.

**Check for updates automatically**, beside it, does the same a few seconds after the app starts and
then once a day, and tells about each new version once, as a notification. It is off until you turn
it on. These are the only requests ShellYard makes to the internet itself: GitHub receives the
address of your machine and the name "ShellYard-desktop", nothing else.

## Commands

| Command | What it does |
|---|---|
| `shellyard start` | Starts the server in the background (if it is not running) and opens the browser |
| `shellyard` | The same as `shellyard start` |
| `shellyard --port <n>` | Starts on that port, or the next free one (default 7717) |
| `shellyard --no-open` | Does not open the browser |
| `shellyard --foreground` | Runs attached to the terminal, with logs on screen |
| `shellyard status` | Says whether the server is running, where, and with how many sessions |
| `shellyard stop` | Stops the server and every session it hosts |

The server keeps running when you close the terminal you started it from, and your sessions keep
running when you close the browser tab. Open the page again with `shellyard`.

> **Shells stay open until you close them in ShellYard.** Closing the browser tab, or quitting the
> desktop app (also from its tray menu), leaves the server running in the background with every
> shell and Claude Code session in it. A session ends only when you close it with its `✕` in
> ShellYard. `shellyard stop` stops the server and its sessions, but the ones still open then are
> started again at the next start (see below), so close in ShellYard the shells you no longer want.

## What you see

| | |
|---|---|
| ![The board: the sessions waiting for you first, then the areas](https://raw.githubusercontent.com/Netrumble/shellyard/main/docs/media/board.png) | ![Needs attention: the queue of requests, with the live terminal and the answers](https://raw.githubusercontent.com/Netrumble/shellyard/main/docs/media/needs-attention.png) |
| **Board** | **Needs attention** |
| ![Terminals: every session side by side](https://raw.githubusercontent.com/Netrumble/shellyard/main/docs/media/terminals.png) | ![Timeline: the last hour of each session](https://raw.githubusercontent.com/Netrumble/shellyard/main/docs/media/timeline.png) |
| **Terminals** | **Timeline** |

- **Board** — the opening page. It starts with the sessions waiting for you, as cards with a
  wait timer and the answers that fit (allow once, deny, always in this area). The areas follow,
  the busiest first, each with its folder and branch, a bar by state and one row per session
  (state, model, a five-minute sparkline, age). Click a session to open its terminal; click the
  area's name to open all its terminals side by side; drag a session to another area to move it
  there. A switch shows the board as **Areas**, as a **Timeline** of the last hour per session
  (working, waiting on you, finished), or as a **Wall** of every terminal side by side.
- **Needs attention** — a queue: the waiting sessions on the left, the one selected on the right
  with its request, its live terminal and the answers. It is meant for the keyboard: `A` allows
  once, `D` denies, `S` allows and adds an area rule (see below), `R` puts the cursor in the
  terminal, `J`/`K` or the arrows move, `Enter` opens the terminal. After an answer the queue moves
  on by itself. Allow and deny are offered only for requests that can be read in full and open on
  a plain "Yes" (Bash, Edit, Write, WebFetch, MCP tools); anything else (a plan to approve, a
  question, a command cut short) is answered in the terminal.
- **Terminals** — every session side by side, or one maximised.
- **Sidebar** — navigation, the sessions grouped by area, and your launchers: click one to start a
  session from it, or press Alt+1 to Alt+9.

### Find in a terminal

**Ctrl+Shift+F** (**Cmd+F** on a Mac) opens a search bar over the terminal that has the focus. It
searches the screen and the scrollback (the last 5000 lines), highlights every match and counts
them; text selected in the terminal is searched for at once. `Enter` goes to the next match,
`Shift+Enter` to the previous one, `Aa` matches case and `.*` takes a regular expression; `Escape`
closes the bar and gives the keys back to the terminal. Plain Ctrl+F is left to the program in the
terminal, where shells use it to move the cursor.

### Command palette and Focus

**Ctrl K** (**Cmd K**) opens a palette that jumps to a session (waiting ones first), an area, a
launcher, a view or a conversation to resume, or runs an action. In a terminal Ctrl K cuts the rest
of the line, so there **Ctrl Shift K** opens it.

**Focus 45 min**, in the header, lets only permissions and questions interrupt for 45 minutes:
sessions that finish meanwhile come in one digest at the end, notified if the page is not in view.
Sound settings are untouched; Focus only filters which events make one.

### Act on several sessions

Shift-click (or Ctrl/Cmd-click, Shift+Enter, Shift+Space) picks sessions on the board. A bar at its
foot then sends one prompt to all of them, marks the finished ones as seen, or moves them to an
area, and says what happened to each. A prompt is typed only into Claude Code sessions waiting at
their prompt; a session at work, blocked on a question or still starting is left alone and listed
as refused. Escape lets go of the selection.

### Area rules

An area can let its sessions run some Bash commands without asking. A rule is a command word by
word, `*` last for any further arguments: `dotnet test *`, `git status`. When Claude Code asks for a
permission, a rule of the session's area that covers the command answers "allow", and the session
never stops. **Always in this area** (on a waiting card, or `S` in the queue) allows the request
and adds the rule made from its command: the program and its subcommand with any arguments for
programs known to have subcommands (git, dotnet, npm…), the exact command for any other. The area's
menu opens its rules: switch them on or off, delete, add, and see how many interruptions each
avoided this week.

A rule never covers a command that chains, pipes, redirects, substitutes, spans several lines or
starts with `VAR=value`, quoted or not. A damaged `rules.json` gives fewer rules, never more.

### Start from ticket

**Start from ticket** on the board turns a ticket code into a place to work, in one step: a git
worktree on the ticket's branch, an area in it named after the ticket, and the sessions of a
*recipe* started there, each Claude Code one given its first prompt as soon as it is ready. The
dialog shows the numbered steps before anything is done.

A recipe names the repository, the base branch, the branch and the folder of the worktree (with
`{ticket}`, `{ticket-lower}` and `{repo}` in them) and up to ten sessions, each with a launcher, a
model and a first prompt. Recipes are edited in the same dialog and kept in `recipes.json`. An
existing branch is checked out as it is. A ticket that already has an area, or a recipe whose
launcher is gone, is refused before git is touched; if the area cannot be made, the new worktree
and branch are taken away again.

### Areas

An area is a named group of sessions, typically one piece of work such as a ticket: give it a
name, optionally a ticket code, a folder and a colour; if you choose no colour, one is picked at
random, kept apart from the colours of the other areas. Sessions started inside an area begin in
its folder and take its colour unless you choose otherwise. Create, edit and delete areas on the
board. A session moves to another area, or out of any area, by dragging its light on the board
or with the selector in its title bar. Deleting an area does not stop its sessions. The sidebar
lists the sessions under their area, and the attention panel and the terminals view can be
filtered by area.

(In `config.json` and in the code an area is called a "story", its first name.)

The tab title shows how many sessions are waiting, and a browser notification appears when one
starts waiting while you are looking elsewhere. Clicking the notification opens that session (the
board, if it has been closed since); in the desktop app it also brings back the window, even
when it is hidden in the notification area or the menu bar.

When you start a Claude Code session you can choose its model.

### Reordering and the sidebar

Areas, sessions and launchers can be dragged to put them in the order you like: drop one before
or after another, and a line shows where it will go. On the board, drag an area by its header to
move it left or right; in the sidebar, drag an area, a session or a launcher up or down. Dropping
a session on another session in a different area also moves it to that area. The order is kept
by the server, so every tab and the next start show it. The line is not shown over the item you are
holding.

The sidebar can be folded away to leave more room, and its Sessions and Launchers sections, like
each area in it, fold too; the board keeps the order of the areas.

### Sounds

**Sounds…** in the header opens the sound settings. Three events can each have their own sound:
a session that needs permission, one that finished, and one that may be waiting. Each plays the
chime unless you choose a sound you added: add an mp3, wav or ogg file with **Add sound…**, play
it to hear it, and delete it when you no longer want it (settings and areas using it go back to
the defaults). An area can also have a sound of its own, chosen when you create or edit it; it
is played instead of the sound of the event when one of its sessions starts waiting. When several
sessions start waiting together, one sound plays: that of the most urgent one. The page stays
silent while you are looking at it, and the **Sound** checkbox switches all of this off.

### Conversations, and what comes back after a restart

ShellYard can only show terminals it started itself: a session running in another window belongs to
that window and cannot be taken over. What it can do is continue the *conversation*, because
Claude Code saves every conversation on disk. **Conversations** in the sidebar lists the recent
ones, whichever window they were held in, and **Resume here** starts a new session in ShellYard with
the whole conversation in it, in the folder it was held in. Close the conversation in the other
window first.

When the server is stopped and started again, the sessions that were open come back by
themselves: Claude Code sessions resume their conversation, and shells are reopened in the same
folder under the same name and story (a shell's running programs and history are not
recoverable). Sessions you had closed do not come back by themselves. To switch this off, set
`"restoreSessions": false` in `config.json`.

Sessions you closed, or that ended, can be opened again by hand: on the board, the `↺` button
of an area lists them, those closed in that area first and then those closed anywhere else.
**Reopen here** starts the session again in that area: a Claude Code session on the
conversation it was holding, a shell as a new shell in the same folder. The last fifty are kept.
In the **Conversations** view, "Resume into" chooses the area a resumed conversation goes to.

### Schedules

A schedule gives a prompt to a new Claude Code session at set times, as if you had typed it.
**Schedules** in the sidebar lists them; **New schedule** asks for:

- a name (also the name of the sessions it starts) and the prompt, which may have several lines;
- when it runs: on chosen days of the week at a time, every so many minutes or hours (5 minutes
  at least, counted from the last run), once at a date and time, or a cron expression of five
  fields (minute, hour, day of month, month, weekday). Times are the local time of the computer
  ShellYard runs on;
- the Claude Code launcher, optionally a model, an area and a folder;
- how the session asks before acting: as Claude Code is set up, or one of its modes (ask before
  every action, edit files without asking, auto, plan only). In *auto*, Claude Code decides by
  itself which actions are safe and does them without asking, so a scheduled session can act
  while nobody is at the screen; choose it only for prompts you would let run unattended. The
  mode that skips every check (bypass permissions) is not offered.

At its time the schedule opens a session like any other: it is a light on the board, in its
area. The prompt is typed into the terminal when Claude Code is ready for it. If Claude Code asks
for a permission, the session waits under **Needs attention** until you answer.

Each schedule shows its next run and how the last one went, and **History** lists the last
twenty runs: *Prompt given*, *Session open, prompt not given* (Claude Code did not become ready,
or did not confirm it took the prompt), *Could not start* (with the reason) or *Skipped*.

Beside that, a run says how it is going or went: *Working for 3m*, *Done in 4m · $0.42 · waited on
you 2m*, or *Waiting on you for 12m*. A run is done when Claude Code finishes its turn after the
prompt; its duration counts from the start of the run. A session closed or ended before that
makes the run *Ended after 6m, before finishing*. A run still at work when ShellYard stops is
*Stopped with ShellYard, before finishing*: its session comes back as a new one, so the run is
not followed further, and the time ShellYard was off is not counted as waiting on you. Runs
from before ShellYard followed them say nothing of how they went. The cost is Claude
Code's own estimate for the session until the run's turn ends (see Usage); what you go on to ask in
that session afterwards is not counted. A run that waits on a permission or a question for more
than 10 minutes is marked, its schedule stands out in the list, and a notification reminds you
once for that wait, even if the page is in view, since the first one went unanswered. **Run
now** starts a run at once without moving the timetable; the **On** box pauses a schedule.

Things to know:

- Schedules run only while ShellYard is running. A run whose time passed while it was not is recorded
  as skipped, unless the schedule is set to run once when ShellYard next starts.
- A run is skipped while the session of the previous run is still working or waiting on a
  permission, so that runs do not pile up.
- Sessions a schedule opened stay open until you close them.
- Deleting an area leaves its schedules, which then run outside any area.
- A schedule is tied to its launcher as it was when the schedule was saved. If the launcher's
  command, arguments or environment change afterwards, its runs fail (*Could not start*) until you
  open the schedule and save it again: an unattended run never starts something you did not see.

### Folders

Wherever a folder is asked for (a new story, a new session, a launcher), you can type the path
or press **Browse** to walk through the folders of the machine and pick one.

Each launcher has a start folder: the folder its sessions open in. The pencil beside a launcher in
the sidebar opens its settings, where you set its name, the start folder and the terminal background. A
built-in launcher can be put back to its default there, and a launcher of your own can be deleted. When a session starts, the folder is the one
chosen in the new-session dialog if any, else the story's folder if the session is in a story
that has one, else the launcher's start folder, else your home folder.

### WSL

On Windows, each WSL distribution installed on the machine is offered as a launcher of its own
("WSL: Ubuntu"), found by asking `wsl.exe`; a distribution added later shows up within a minute.
Its sessions are a Linux shell in that distribution. They start in the session's folder like any
other, which Linux shows under `/mnt/c/...`; type `cd` to go to your Linux home. Docker's own
distributions are not listed.

Claude Code started by hand inside a WSL shell runs, but ShellYard does not see its status: the
status lights, the attention panel and schedules work with the Claude Code launcher, which runs
on Windows.

### The same session in two tabs

A session has one size, and the program in it draws for that size. If the same session is on
screen in two tabs or windows, the one you are using decides the size (it is the one shown, or
the one whose terminal you click), and the other draws the terminal at that size too, even
where it does not fill its own tile or is cut off. Click a terminal to make its page the one
that decides.

### Open in VS Code

Every session has a VS Code button, in its title bar and in its sidebar row. It opens VS Code on
the folder the session was started in, on the computer ShellYard runs on. For a WSL session the folder
is opened inside its distribution, through VS Code's WSL extension, also when it is a Windows
folder (seen there as `/mnt/c/...`) or the Linux home. VS Code is found through its `code` command
on the PATH. The folder is the one the session started in: where its shell has moved to since is
not known to ShellYard.

### Phone access

ShellYard can also be opened from a phone or tablet on the same network as your computer, your
home Wi-Fi for instance: the same board, terminals and answers as on the computer, laid out for
a small screen.

1. Open the sliders button at the right end of the header (**Theme, effects and sound**), choose
   **Phone access…**, then tick **Let devices on this network open ShellYard**.
2. Scan the QR code with the phone's camera. It opens `http://<your computer's IP>:7718` with the
   key to get in; the phone keeps it, so a bookmark or a home-screen icon works from then on.

While it is on, a phone icon in the header says so, with the number of devices connected; click
it to open the same dialog. When the computer is on several networks (Wi-Fi and Ethernet, or
WSL's virtual network), choose the one the phone is on. **New link** makes a new key: every device
using the old one is disconnected. Untick the box to switch it off; it stays as you left it
across restarts.

Things to know:

- Whoever has the link controls your sessions as you do on the computer. The connection is not
  encrypted beyond your network's own: use it on networks you trust (see [Security](#security)).
- The first time, Windows asks whether Node.js may accept connections: allow it on **private**
  networks. If the phone shows a blank page or cannot connect, that is the first thing to check.
  Windows asks only once: if the question was refused (even long ago, for another program run
  by the same `node.exe`), a **Block** rule for `node.exe` stays in *Windows Defender Firewall
  with Advanced Security* › *Inbound Rules*, and it wins over any rule that allows. Disable it,
  then allow TCP port 7718 on private networks, for instance from an administrator PowerShell:
  `New-NetFirewallRule -DisplayName "ShellYard phone access" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7718 -Profile Private -Program "<path of node.exe>"`.
- On the phone, browsers keep notifications and the clipboard for secure (HTTPS) addresses, so
  those are not available there. Keep the page open on the phone to follow your sessions.
- The port is 7718, or the next free one. Another can be set as `"lan": { "port": 7800 }` in
  `config.json`.

### Git worktrees

A session in a git repository shows a chip in its title bar, `⎇ branch · worktree`: the branch
checked out in the folder it works in (a short commit id when no branch is), and the name of that
worktree's folder. A Claude Code session follows the folder Claude reports, so the chip changes
when Claude moves to another worktree; for other sessions it shows the folder the session started
in.

The chip's menu lets you move the session to another worktree of the repository, or switch the
branch of its worktree. Moving a session restarts it. For Claude Code that means a new
conversation in the new folder: the old one stays in Conversations, where you can resume it.
Moving is not offered for WSL sessions. Switching away from a commit that is on no branch asks
first, as that commit is then left behind.

**Manage worktrees…** (in the chip's menu) lists the worktrees of the repository. There you
create one, choosing an existing branch or a new one and the folder (by default beside the main
worktree), and delete one. Before deleting, ShellYard asks about what would be lost: sessions
still open in it, uncommitted changes, commits that are on no branch, and the files git ignores
(like `.env`), which are deleted too. Commits on no branch are never lost without that
confirmation: the server refuses to delete such a worktree otherwise. You can also delete the
worktree's branch; if that branch is not merged, the branch is kept and a warning says so.

When other sessions are working in a worktree, moving a session there or switching the branch of
that worktree asks first: they all share the same files, and the branch changes under all of them.

In the new-session dialog, when the folder is in a repository with more than one worktree, a
**Worktree** choice appears under Folder. Pick one to start the session there, in the same
sub-folder if it exists in that worktree. **Manage…** opens the same dialog to create one first.
The choice is not offered for launchers that set their own folder (WSL, `--cd`).

### Uncommitted changes

When the worktree a session works in has changes that are not committed, a badge beside the
branch chip says how many: `3 files +42 −7`. The session's row on the board shows the lines too.
Click the badge to see them: the changed files on the left (modified, added, deleted, new and not
tracked yet), and the diff of the one chosen on the right, against the last commit, staged or
not. The arrows (or `J`/`K`) move through the files; **Refresh** reads them again.

The badge is read again shortly after Claude Code uses a tool or finishes a turn, and every 15
seconds for changes made elsewhere (an editor, a shell), and the open dialog follows. A commit
takes the files out. These are the changes of the whole worktree, whoever made them: sessions
that share a worktree share its badge. Files git ignores are not listed; a binary file, or a diff
larger than 1 MB, is listed without its lines.

### Terminal background

A terminal normally follows the theme. In a launcher's settings you can give its sessions another
background: a colour, or an image of yours (PNG, JPEG, WebP or GIF, up to 8 MB) shown under a
grey-black veil whose strength you set, so that text stays readable. The image is copied into
ShellYard's own folder. The `◐` button in the title bar of a terminal changes the background of that
one terminal while it is open, without touching the launcher.

### Terminal font and text size

The same two places set the text of a terminal: a launcher's settings (the pencil) for the
sessions it starts from then on, and the `◐` button of an open terminal for that terminal alone,
where the change shows at once. Choose a font from the list, or *Other…* to type the name of any
fixed-width font installed on the computer the browser runs on; choose a size from 10 to 32
pixels. Left alone, a terminal uses Cascadia Mono (or Consolas) at 13. A session keeps its font
when it is closed and reopened, and across a restart.

If terminal text looks small or soft, check the browser's zoom first (Ctrl+0 puts it back to
100%): a page zoomed out draws every letter with fewer pixels. Then raise the size here.

### Usage

The header shows how much of your Claude plan limits is used: the 5-hour limit and the weekly
limit, as two small dials and a row of lights that fills up and turns red near the end. The
Usage view shows the same on large dials, with the time left before each limit resets, and
what the sessions started from ShellYard have cost: today, over 7 days and over 30 days, by model and
by story.

What these figures are, and are not:

- They come from Claude Code itself, and cover all Claude Code use on this machine, in whatever
  window, going back 30 days. Sessions running in ShellYard are counted as they go, from what Claude
  Code reports to ShellYard. Sessions in other windows are read from the conversation files Claude
  Code keeps, where it writes a conversation's cost only when the session ends or is resumed:
  so a session still running in another window is not in today's figure until it ends.
  In the table by model, a cost goes to the model in use when it was reported, so a switch of
  model in the middle of a turn is attributed approximately.
- The cost is Claude Code's own estimate of what the tokens would cost at API prices. On a
  subscription you are not billed that amount; it is a measure of how much you used.
- The limit dials update only while a Claude Code session started here is active. The header
  and the Usage view say how old the reading is, and shows "no data" instead of a number when it has none or when
  the limit has reset since the last reading. Accounts without plan limits (API keys) show
  "no data".

History is kept for 90 days in `usage.json`.

The Usage view also shows **Your flow today**: how long Claude Code sessions were blocked on you,
how fast you answered (the median), how many sessions worked at once, and how many requests the
area rules answered for you, each against the average of the previous week. The board's summary
repeats the median answer and the time blocked. These figures are kept for two weeks in
`flow.json`, as totals only.

### Instruments and effects

The interface is styled as a sports-car instrument cluster. Beside each session a small rev
counter shows how much its terminal is printing right now; the header has one lamp per session
(green working, amber pulsing when it needs you, chequered when it has finished); a flag passes
over a card when its session finishes.

**Theme** in the header chooses light or dark, or *System* to follow your operating system (the
starting choice). Terminals follow the theme; on the light one, colours that programs chose for
a dark terminal are darkened as needed to stay readable. A third theme, *Talentia*, uses the
colours of the Talentia website: a navy sidebar, magenta for the main actions, a turquoise main
dial, on a light page with dark navy terminals.

The **Effects** menu in the header sets how much of this moves: *Full*, *Reduced* (colours and
values stay, sweeps, pulses and rolling digits go) or *Off* (also no rev counters or small
dials). If your system asks for reduced motion, *Reduced* is the starting choice. **Sound**
adds a soft chime when a session starts waiting for you, and lets the system notification of a
waiting session make its sound; it is on unless you turn it off. With **Sound** off the page is
silent: no chime, and notifications are shown without sound. Sounds a program makes by itself on
the computer, outside the browser, are not the page's to switch off.
Every dial and lamp also gives its value as text; the rev counters are decoration, since each
session's status is already written beside its name.

## When something goes wrong

An unexpected error (a fault in the server, a failure of the page, or a server that does not
start) is written to a report file of its own in `~/.shellyard/errors/`, and ShellYard tells you
where it is:

- a notice at the foot of the page, with the error, the full path of the report, **Copy path**
  and **Show in folder** (Finder, Explorer or the file manager, with the file selected where it
  can be). The same error again counts on its notice (`×3`) instead of making a new one;
- a system notification as well, when the page is not in view;
- if the page itself breaks, a page that says so, with the report and a **Reload** button: your
  sessions keep running;
- if the server does not start, `shellyard` (or the desktop app) prints the path of the report
  with the last lines of the log.

**Recent errors…** in the settings menu lists the errors since the server started. A report holds
the message, the stack, what was being done, the versions of ShellYard, Node and the system, and
the last lines of `shellyard.log`; the access tokens and the page's address are taken out, so it
can be attached to an issue. The fifty newest are kept. Refusals you can act on (a branch git
turns down, a session that cannot start) are not errors here: they are said where they happen.

## How the status of a Claude Code session is known

ShellYard starts `claude` with an extra settings file of its own (passed with `--settings`) that
registers hooks and a status line. Claude Code then tells ShellYard when a prompt is submitted, when a
tool runs, when it asks for permission and when it finishes, and reports its usage figures. Your
own Claude Code settings are not modified, your own hooks keep working, and if you have a status
line of your own it is still shown: ShellYard's passes your status line's output through unchanged.

Claude Code sends no event when you deny a permission or interrupt a turn with Esc. For those
cases ShellYard watches the terminal: a session that is supposedly working but has printed nothing for
5 seconds is shown as "possibly waiting". The delay is `silenceMs` in the config file.

Known limits:

- A terminal has one size. The same session open in two browser tabs will follow whichever tab
  resized last.
- Stopping the server ends the processes of its sessions; see above for what comes back.
- If your Claude Code permission mode is "auto", Claude does not ask for permissions, so sessions
  go from working straight to finished.
- A session that is waiting but keeps printing something at least every 5 seconds (a status
  line on a timer, for example) is not caught by the "possibly waiting" rule.
- A dialog Claude shows before the first prompt (folder trust, login) appears as "idle".
- Of a launcher, the name, the start folder and the terminal background can be changed in the page; its
  command and arguments are edited in `config.json` (under `profiles`, the name launchers keep there). A custom command takes no arguments field yet.
- Some key combinations are taken by the browser before they reach the terminal (Ctrl+W, Ctrl+T,
  Ctrl+N). Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V pastes. On a Mac,
  Cmd+C and Cmd+V copy and paste as well. Ctrl+Shift+F (Cmd+F on a Mac) opens
  the search instead of reaching the program.

## Where things are kept

Everything is in `~/.shellyard/`:

| File | Content |
|---|---|
| `config.json` | Your launchers (`profiles`), your stories, the model list, `silenceMs`, phone access (`lan`) |
| `server.json` | The running server's port and access token (readable by you only) |
| `shellyard.log` | The server log |
| `sessions.json` | The sessions open right now, to bring them back after a restart |
| `closed.json` | The last fifty sessions that ended or were closed, to reopen them |
| `backgrounds/` | The images uploaded as terminal backgrounds |
| `schedules.json` | The schedules, with the last twenty runs of each |
| `rules.json` | The area rules: Bash commands an area's sessions run without asking |
| `recipes.json` | The recipes of Start from ticket |
| `flow.json` | Time blocked on you and answer times, per day, for two weeks |
| `usage.json` | Usage history: cost and tokens per day, model and story (90 days), and how far each of Claude Code's conversation files has been read |
| `open.html` | The private page `shellyard` opens in your browser (readable by you only) |
| `lan.json` | The key of the [Phone access](#phone-access) link, made the first time it is switched on (readable by you only) |
| `run/` | Per-session settings files, removed when a session ends |
| `errors/` | One report per unexpected error, the newest fifty (see [When something goes wrong](#when-something-goes-wrong)) |

Set `SHELLYARD_HOME` to use another folder.

## Security

Whoever can reach the server gets a shell as you, so:

- it listens on `127.0.0.1` only, never on the network (unless you switch on
  [Phone access](#phone-access); see below);
- every API request and WebSocket connection needs a random token created at each start (the
  page's own files and the health check, which hold no secret, are served without it).
  `shellyard` hands it to your browser in
  the fragment of the address (the part after `#`, which browsers never send to a server); the
  page keeps it and sends it explicitly with each request. No cookie is used, so the token is
  not sent to other programs listening on this machine;
- the page is opened on a new address at every start, `http://<32 random characters>.localhost:7717`
  (browsers send any `*.localhost` name to this machine by themselves). A fixed address could be
  prepared in advance: whoever holds the port while ShellYard is down (another user of the
  machine can) could leave a service worker there that answers in place of the server at the
  next start and reads the token. Settings kept by the page in the browser (theme, collapsed
  areas, board sizes) therefore start over after each restart of the server;
- requests and WebSocket connections coming from other web pages or other host names are refused.
  The app is served only on the address of the current start; on `127.0.0.1`, which the
  `shellyard` command and Claude Code's hooks use, a page only says how to open it. `localhost`
  is not accepted;
- `shellyard` makes sure the server on the recorded port is really its own (it must answer a
  random challenge with the token) before it sends it the token or stops its process;
- the Windows programs ShellYard runs itself (`wsl.exe`, `cmd.exe`, `taskkill.exe`) are started
  from System32 by full path, never looked up in the folder of a session, and the background
  server runs in `~/.shellyard/`, not in the folder `shellyard` was started from;
- the browser is started on a private file, not on the address, so the token does not appear on
  a command line that other users of the machine could read.

After the server restarts, a tab left open from before is told to run `shellyard` again.

Phone access, while it is on, is a second door, held to rules of its own:

- it is a listener of its own, on another port (7718), that exists only while the switch is on.
  The `127.0.0.1` listener is never opened to the network;
- it answers only this computer and private networks (`10.*`, `172.16–31.*`, `192.168.*`,
  link-local `169.254.*` and `100.64–127.*`, which Tailscale uses), and only when it is addressed
  by an IP address: a name is refused, so a web page that points a name of its own at your
  computer (DNS rebinding) gets nothing;
- it takes its own token, never the per-start one, and the `127.0.0.1` listener does not take
  its token. Requests that change something, and the WebSocket, must come from the page's own
  address;
- it does not serve Claude Code's hooks and status reports, the shutdown, or the health check's
  proof: those are for the programs of this computer;
- **New link** replaces its token: every device holding the old one is disconnected at once and
  refused from then on.

What it does not protect against:

- the connection is plain HTTP. On your network, the page, your terminals and the link travel
  as protected as the network makes them (WPA2/WPA3 on a Wi-Fi with a password). Someone who
  can read that traffic, or who has the link, has a shell as you;
- the phone keeps the link for its address (`http://<computer's IP>:7718`). On a network you
  do not control, another device that takes your computer's address while it is away could
  serve a page there and read it. Use phone access on networks you trust, switch it off
  elsewhere, and press **New link** if in doubt;
- the link outlives restarts (it is kept in `lan.json`) until you make a new one.

If you edit `config.json` by hand and it is not valid JSON at that moment, ShellYard keeps using the
last settings that were valid and refuses to save changes from the page until the file is fixed.

Any program running as you can read the token from `~/.shellyard/`; ShellYard does not
protect you from your own account. "Readable by you only" means file mode 600 and folder mode
700 on Linux and macOS; Windows ignores those modes, and there the files are protected by the
permissions of your user profile folder.

The desktop app adds no way in:

- its window runs the page isolated from your system (`contextIsolation` and `sandbox` on, no Node
  access), and cannot navigate away from the ShellYard server: links open in your browser;
- it uses the same token as the browser. Its page runs in a storage session of its own, kept in
  memory and emptied before each load, so nothing it stores (a service worker included) outlives
  the app. It stores no cookies;
- the setup program installs for your account only and needs no administrator rights. It is not
  code-signed yet: download it only from this repository's
  [releases](https://github.com/Talentia-Software-OSS/shellyard/releases) and check it against
  its published SHA-256 checksum. It is built from the repository's lockfile, so it contains
  exactly the dependency versions that were tested.

Known gap, not yet closed:

- A program that prints without pause for a very long time is not slowed down to the pace of
  the browser; a stalled tab makes the server use more memory.

Sessions run with the privileges `shellyard` was started with. To get an elevated shell, start `shellyard`
from an elevated terminal.

## Development

```
npm install
npm test            # unit and integration tests
npm run build       # server (tsc) and web UI (vite) into dist/
node dist/cli/shellyard.js --foreground
```

At every push to `main`, the [Desktop installers](.github/workflows/desktop-installers.yml)
workflow runs the tests, builds the Windows setup program and the macOS disk images for Apple
Silicon and Intel (each on its own system and processor) and publishes them, with their
checksums, as a GitHub release. It can also be started by hand (Actions → Desktop installers →
Run workflow). Every pull request is checked by the [Checks](.github/workflows/checks.yml)
workflow first: types, tests and build on Windows, macOS and Linux.

The version of each release is worked out by the workflow: `VERSION_BASE` at its top gives the
major and minor (its patch stays 0), and the patch is one more than the highest already released
with that major and minor. With `VERSION_BASE: 0.2.0` and `v0.2.0` released, the next push gives
`v0.2.1`, then `v0.2.2`; to start 0.3, set `VERSION_BASE` to `0.3.0`, and the first release is
`v0.3.0`. The version is set in the packages only for the build: `package.json` in the repository
is not changed, and the npm packages are published separately. See
[desktop/README.md](desktop/README.md) to build the installers locally.

## Licence

MIT. See [LICENSE](LICENSE).
