{ lib, headMode ? "graphical", hostSystem ? null, ... }:
lib.mkIf (headMode == "graphical") (
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;

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
    macos-titlebar-style = "tabs"
    window-padding-x = 16
    window-padding-y = 4
    background-opacity = "0.7"
    background-blur = "8"

    theme = light:vesper-light,dark:vesper-dark

    keybind = shift+enter=text:\n
  '';

  sharedHomeConfig = {
    home.file.".config/ghostty/config" = {
      force = true;
      text = ghosttyConfig;
    };
    home.file.".config/ghostty/themes/vesper-light" = {
      force = true;
      text = vesperLightTheme;
    };
    home.file.".config/ghostty/themes/vesper-dark" = {
      force = true;
      text = vesperDarkTheme;
    };
  };
in
if isDarwin then {
  # darwin: ghostty pkg marked broken in nixpkgs, use homebrew cask
  homebrew.casks = [ "ghostty" ];
  home-manager.users.bdsqqq = { ... }: sharedHomeConfig;
} else if isLinux then {
  # linux: use nix package
  home-manager.users.bdsqqq = { pkgs, ... }: sharedHomeConfig // {
    home.packages = [ pkgs.ghostty ];
  };
} else {}
)


