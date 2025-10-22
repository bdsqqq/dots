{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  
  ghosttyConfig = ''
    font-family = "Berkeley Mono"
    macos-titlebar-style = "tabs"
    window-padding-x = 16
    window-padding-y = 4
    background = #101010
    foreground = #c2c2c2
    background-opacity = "0.6"
    background-blur = "8"
    selection-invert-fg-bg
    macos-icon = "custom-style"
    macos-icon-screen-color = #101010
    macos-icon-ghost-color = #c2c2c2
    keybind = shift+enter=text:\n
  '';
in
if isDarwin then {
  # darwin: ghostty pkg marked broken in nixpkgs, use homebrew cask
  homebrew.casks = [ "ghostty" ];
  
  home-manager.users.bdsqqq = { ... }: {
    home.file.".config/ghostty/config" = {
      force = true;
      text = ghosttyConfig;
    };
  };
} else if isLinux then {
  # linux: use nix package
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [ pkgs.ghostty ];
    
    home.file.".config/ghostty/config" = {
      force = true;
      text = ghosttyConfig;
    };
  };
} else {}


