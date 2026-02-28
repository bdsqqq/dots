{ lib, pkgs, headMode ? "graphical", hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;

complineDarkTheme = ''
  # from https://github.com/joshuablais/compline/blob/main/ghostty/compline
  background = #1a1d21
  foreground = #f0efeb
  cursor-color = #d4ccb4
  cursor-text = #1a1d21
  selection-background = #3d424a
  selection-foreground = #f0efeb
  palette = 0 = #22262b
  palette = 1 = #cdacac
  palette = 2 = #b8c4b8
  palette = 3 = #d4ccb4
  palette = 4 = #b4bcc4
  palette = 5 = #ccc4b4
  palette = 6 = #b4c0c8
  palette = 7 = #8b919a
  palette = 8 = #515761
  palette = 9 = #cdacac
  palette = 10 = #b8c4b8
  palette = 11 = #d4ccb4
  palette = 12 = #b4bcc4
  palette = 13 = #ccc4b4
  palette = 14 = #b4c0c8
  palette = 15 = #e0dcd4
'';

laudsLightTheme = ''
  # from https://github.com/joshuablais/compline/blob/main/ghostty/lauds
  background = #f0efeb
  foreground = #1a1d21
  cursor-color = #8b7e52
  cursor-text = #f0efeb
  selection-background = #d8d6d3
  selection-foreground = #1a1d21
  palette = 0 = #5f5c58
  palette = 1 = #8b6666
  palette = 2 = #5a6b5a
  palette = 3 = #8b7e52
  palette = 4 = #5a6b7a
  palette = 5 = #8b7e52
  palette = 6 = #64757d
  palette = 7 = #4a4d51
  palette = 8 = #7d7a75
  palette = 9 = #8b6666
  palette = 10 = #5a6b5a
  palette = 11 = #8b7e52
  palette = 12 = #5a6b7a
  palette = 13 = #8b7e52
  palette = 14 = #64757d
  palette = 15 = #2d2a27
'';

  vesperDarkTheme = ''
# Based on https://github.com/studio1804/ghostty-theme/blob/main/themes/studio1804-modern.conf
# and https://github.com/raunofreiberg/vesper/blob/main/themes/Vesper-dark-color-theme.json
# Standard ANSI colors (0-7) - Studio1804 pure grayscale palette
palette = 0=101010
palette = 1=dc2626
palette = 2=6b7280
palette = 3=f97316
palette = 4=374151
palette = 5=d1d5db
palette = 6=6b7280
palette = 7=c2c2c2

# Bright ANSI colors (8-15) - Studio1804 enhanced palette
palette = 8=404040
palette = 9=ef4444
palette = 10=9ca3af
palette = 11=#99FFE4
palette = 12=6b7280
palette = 13=#FFC799
palette = 14=9ca3af
palette = 15=ffffff

# Core terminal colors
background   = 101010
foreground   = c2c2c2
cursor-color = FFC799

# Selection colors
selection-background = A4A4A4
selection-foreground = ffffff
'';

  vesperLightTheme = ''
# based on https://github.com/e-ink-colorscheme/e-ink.ghostty/blob/main/e-ink
background = #C2C2C2
foreground = #101010

selection-background = #E5E5E5
selection-foreground = #000000

palette = 0=#C2C2C2
palette = 1=#333333
palette = 2=#9A9A9A
palette = 3=#868686
palette = 4=#727272
palette = 5=#AEAEAE
palette = 6=#4A4A4A
palette = 7=#5E5E5E

palette = 8=#5E5E5E
palette = 9=#333333
palette = 10=#9A9A9A
palette = 11=#99FFE4
palette = 12=#727272
palette = 13=#FFC799
palette = 14=#4A4A4A
palette = 15=#7C7C7C
'';

  ghosttyConfig = ''
font-family = "Berkeley Mono"
macos-titlebar-style = "hidden"
window-padding-x = 16
window-padding-y = 4
background-opacity = 0.7
background-blur-radius = 8
background-opacity-cells = true

theme = light:lauds-light,dark:compline-dark

# --- ctrl+shift workaround for tmux ---
#
# ghostty supports modifyOtherKeys (CSI u) natively, but when tmux is
# the child process the negotiation doesn't reliably activate. tmux
# sends CSI > 4;2m to enable modifyOtherKeys, ghostty has the code to
# handle it, yet ghostty stays in legacy mode and sends 0x10 for both
# ctrl+p and ctrl+shift+p — the shift modifier is stripped.
#
# the csi: keybind action does NOT fix this. ghostty's inspector shows
# "Encoding to Pty: (no data)" for csi: — it gets consumed internally
# without writing bytes to the child process.
#
# text: bypasses the key encoding path entirely and writes raw bytes to
# the pty fd. tmux receives the CSI u sequence, parses it with full
# modifier info, and forwards it to inner apps correctly.
#
# format: text:\x1b[<codepoint>;<modifier>u
#   codepoint = ASCII code of the lowercase letter (p=112)
#   modifier  = 2:shift  5:ctrl  6:ctrl+shift  (xterm convention)
#
# add more ctrl+shift combos here as needed. each needs its own line.
keybind = ctrl+shift+p=text:\x1b[112;6u
keybind = alt+backspace=text:\x1b\x7f

# unbind ctrl+tab/digits so tmux can receive them
keybind = ctrl+tab=unbind
keybind = ctrl+shift+tab=unbind
keybind = ctrl+one=unbind
keybind = ctrl+two=unbind
keybind = ctrl+three=unbind
keybind = ctrl+four=unbind
keybind = ctrl+five=unbind
keybind = ctrl+six=unbind
keybind = ctrl+seven=unbind
keybind = ctrl+eight=unbind
keybind = ctrl+nine=unbind
keybind = ctrl+zero=unbind
'';

  ghosttyFiles = {
    "ghostty/config" = {
      force = true;
      text = ghosttyConfig;
    };
    "ghostty/themes/vesper-light" = {
      force = true;
      text = vesperLightTheme;
    };
    "ghostty/themes/vesper-dark" = {
      force = true;
      text = vesperDarkTheme;
    };
    "ghostty/themes/compline-dark" = {
      force = true;
      text = complineDarkTheme;
    };
    "ghostty/themes/lauds-light" = {
      force = true;
      text = laudsLightTheme;
    };
  };

in lib.mkIf (headMode == "graphical") (
  if isDarwin then {
    homebrew.casks = [ "ghostty" ];
    home-manager.users.bdsqqq.xdg.configFile = ghosttyFiles;
  } else if isLinux then {
    home-manager.users.bdsqqq.home.packages = [ pkgs.ghostty ];
    home-manager.users.bdsqqq.xdg.configFile = ghosttyFiles;
  } else {}
)
