{ lib, config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    home.file.".config/ghostty/config" = {
      force = true;
      text = ''
        font-family = "Berkeley Mono"
        macos-titlebar-style = "tabs"
        window-padding-x = 16
        window-padding-y = 0,4
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
    };
  };
}


