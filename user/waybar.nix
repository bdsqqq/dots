{ lib, pkgs, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;

  waybarConfig = {
    layer = "top";
    position = "top";
    height = 60;
    
    modules-left = [ "custom/logo" ];
    modules-right = [ "clock" ];
    
    "custom/logo" = {
      format = "∗";
      tooltip = false;
    };
    
    clock = {
      format = "{:%Y-%m-%d %H:%M}";
      tooltip = false;
    };
  };

  waybarStyle = ''
    * {
      font-family: "Berkeley Mono", monospace;
      font-size: 32px;
    }
    
    window#waybar {
      background: transparent;
      color: #ffffff;
    }
    
    #custom-logo {
      padding: 0 16px;
    }
    
    #clock {
      padding: 0 16px;
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
