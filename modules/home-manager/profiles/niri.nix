{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    foot
    fuzzel
    grim
    slurp
    wl-clipboard
  ];

  programs.niri = {
    settings = {
      input.keyboard.xkb.layout = "us";
      
      # Minimalist layout inspired by Bauhaus/Rams/Nothing
      layout = {
        gaps = 8;  # Clean 8px gaps
        border = {
          enable = false;  # No focus rings - clean minimal aesthetic
        };
        center-focused-column = "never";
        default-column-width = { proportion = 0.5; };
        preset-column-widths = [
          { proportion = 1.0; }
          { proportion = 0.5; }
          { proportion = 0.33; }
          { proportion = 0.67; }
        ];
      };
      
      # Window appearance - Nothing/minimalist inspired
      window-rules = [
        {
          # All windows: no decorations, rounded corners
          geometry-corner-radius = {
            top-left = 8.0;
            top-right = 8.0;
            bottom-left = 8.0;
            bottom-right = 8.0;
          };
          clip-to-geometry = true;
          opacity = 0.95;  # Subtle transparency
        }
        {
          matches = [{ app-id = "^ghostty$"; }];
          opacity = 0.98;  # Terminals slightly more opaque
        }
        {
          matches = [{ app-id = "^firefox$"; }];
          opacity = 1.0;  # Browsers fully opaque for readability
        }
      ];
      
      # Smooth animations - snappy and minimal
      animations = {
        slowdown = 0.8;  # Snappy timing for minimalist feel
      };
      
      # Essential keybinds - minimal and clean
      binds = with config.lib.niri.actions; {
        "Mod+Return".action = spawn "ghostty";
        "Mod+D".action = spawn "fuzzel";
        "Mod+Q".action = close-window;
        
        # Focus movement
        "Mod+H".action = focus-column-left;
        "Mod+L".action = focus-column-right;
        "Mod+J".action = focus-window-down;
        "Mod+K".action = focus-window-up;
        
        # Workspaces
        "Mod+1".action = focus-workspace 1;
        "Mod+2".action = focus-workspace 2;
        "Mod+3".action = focus-workspace 3;
        "Mod+4".action = focus-workspace 4;
        "Mod+5".action = focus-workspace 5;
        
        # Screenshots
        "Print".action = spawn "grim" "-g" "$(slurp)" "~/Screenshots/$(date +'%Y-%m-%d_%H-%M-%S').png";
      };
      
      spawn-at-startup = [
        { command = [ "mako" ]; }
        { command = [ "xwayland-satellite" ]; }
      ];
      
      # Environment variables for X11 applications
      environment = {
        DISPLAY = ":0";
      };
    };
  };

  programs.foot.enable = true;
}