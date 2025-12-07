# quickshell bar + screen corners

replacing waybar with quickshell for system-wide UI.

## goals
- [x] add quickshell-git flake input
- [x] create user/quickshell.nix module
- [x] create QML config files:
  - [x] shell.qml (entry point)
  - [x] Bar.qml (top bar with logo, workspaces, clock)
  - [x] ScreenCorners.qml (8px rounded corners overlay)
- [x] update niri.nix spawn-at-startup
- [x] update hyprland.nix exec-once
- [x] test build on r56 (build succeeded)

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
- niri: use qml-niri plugin (packaged as overlays/qml-niri.nix)
  - wrapper script sets QML_IMPORT_PATH to include qml-niri
  - NiriWorkspacesLoader.qml handles niri workspace display

### layer ordering (wayland layer-shell)
1. Overlay - bar
2. Top - screen corners, normal panels
3. Bottom - below windows
4. Background - wallpaper layer
