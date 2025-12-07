# quickshell bar + screen corners + notifications

replacing waybar with quickshell for system-wide UI.

## goals
- [x] add quickshell-git flake input
- [x] create user/quickshell.nix module
- [x] create QML config files:
  - [x] shell.qml (entry point)
  - [x] Bar.qml (top bar with logo, workspaces, clock)
  - [x] ScreenCorners.qml (8px rounded corners overlay)
  - [x] NotificationItem.qml (individual notification card)
  - [x] NotificationPopups.qml (popup container with connector shape)
- [x] update niri.nix spawn-at-startup
- [x] update hyprland.nix exec-once
- [x] test build on r56 (build succeeded)
- [ ] test notifications on r56

## design decisions

### bar layout (matching waybar)
- layer: Overlay (above everything)
- position: top, full width
- height: 30px
- solid black background (#000000)
- modules-left: logo (∗), workspaces
- modules-right: clock (YYYY-MM-DD HH:MM)
- font: Berkeley Mono, 16px

### screen corners
- layer: Top (below bar/Overlay, above normal windows)
- 8px radius black quarter-circles at each corner
- top corners positioned below bar (margin-top: 30px)
- bottom corners at screen bottom

### workspace display
- hyprland: use Quickshell.Hyprland module
- niri: use quickshell's native Socket type to talk to NIRI_SOCKET directly
  - no C++ plugin needed (qml-niri removed)
  - NiriWorkspacesLoader.qml connects to niri IPC, sends JSON commands, parses responses
  - approach copied from noctalia-shell's NiriService.qml

### layer ordering (wayland layer-shell)
1. Overlay - screen corners, notifications
2. Top - bar
3. Bottom - below windows
4. Background - wallpaper layer

### notifications
- positioned top-right, below bar (margin-top: barHeight)
- uses NotificationServer from Quickshell.Services.Notifications
- "connector" shape: concave quarter-circle connecting bar edge to notification
- rendered with ShapePath using PathArc counterclockwise
- bottom-left corner of notification list: convex quarter-circle via Canvas
- individual NotificationItem cards with dismiss, actions, auto-expire
- max 5 visible popups, oldest expires first
