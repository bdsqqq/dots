{ lib, pkgs, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;

  waybarConfig = {
    layer = "top";
    position = "top";
    height = 30;
    
    modules-left = [ "custom/logo" "hyprland/workspaces" ];
    modules-right = [ "clock" ];
    
    "custom/logo" = {
      format = "∗";
      tooltip = false;
    };
    
    "hyprland/workspaces" = {
      format = "[{name}]";
      on-click = "activate";
      sort-by-number = true;
    };
    
    clock = {
      format = "{:%Y-%m-%d %H:%M}";
      tooltip = false;
    };
  };

  waybarStyle = ''
    * {
      font-family: "Berkeley Mono", monospace;
      font-size: 16px;
    }
    
    window#waybar {
      background: transparent;
      color: #ffffff;
    }
    
    #custom-logo {
      padding: 0 8px;
    }
    
    #workspaces {
      padding: 0;
    }
    
    #workspaces button {
      padding: 0 4px;
      color: #6b7280;
      background: transparent;
      border: none;
      border-radius: 0;
    }
    
    #workspaces button.active {
      color: #d1d5db;
      font-weight: bold;
    }
    
    #clock {
      padding: 0 8px;
    }
  '';

in
if !isLinux then {} else {
  home-manager.users.bdsqqq = { ... }: {
    programs.waybar = {
      enable = true;
      settings = [ waybarConfig ];
      style = waybarStyle;
    };
  };
}
