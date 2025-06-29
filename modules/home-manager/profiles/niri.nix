{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    foot
    fuzzel
    grim
    slurp
    wl-clipboard
    mako
    waybar
  ];

  programs.niri = {
    settings = {
      input.keyboard.xkb.layout = "us";
      
      layout = {
        gaps = 16;
        border.enable = true;
        border.width = 2;
      };
      
      binds = with config.lib.niri.actions; {
        "Mod+Return".action = spawn "foot";
        "Mod+D".action = spawn "fuzzel";
        "Mod+Q".action = close-window;
        
        "Mod+H".action = focus-column-left;
        "Mod+L".action = focus-column-right;
        "Mod+J".action = focus-window-down;
        "Mod+K".action = focus-window-up;
        
        "Mod+1".action = focus-workspace 1;
        "Mod+2".action = focus-workspace 2;
        "Mod+3".action = focus-workspace 3;
        "Mod+4".action = focus-workspace 4;
        "Mod+5".action = focus-workspace 5;
      };
      
      spawn-at-startup = [
        { command = [ "waybar" ]; }
        { command = [ "mako" ]; }
      ];
    };
  };

  programs.foot.enable = true;
  programs.fuzzel.enable = true;
  services.mako.enable = true;
}