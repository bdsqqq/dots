{ config, lib, pkgs, ... }:

let
  cfg = config.custom.kanata;
in
{
  options.custom.kanata = {
    enable = lib.mkEnableOption "kanata keyboard configuration";
  };

  config = lib.mkIf cfg.enable {
    # Install kanata via homebrew (easier on macOS)
    homebrew.casks = [ "kanata-app" ];
    
    # Create kanata configuration directory
    system.activationScripts.kanata = {
      text = ''
        mkdir -p /Users/bdsqqq/.config/kanata
        cp ${../shared/kanata.kbd} /Users/bdsqqq/.config/kanata/kanata.kbd
        chown bdsqqq:staff /Users/bdsqqq/.config/kanata/kanata.kbd
      '';
    };
    
    # LaunchAgent to run kanata
    launchd.user.agents.kanata = {
      serviceConfig = {
        Label = "com.bdsqqq.kanata";
        ProgramArguments = [
          "/Applications/Kanata.app/Contents/MacOS/kanata"
          "--config-file"
          "/Users/bdsqqq/.config/kanata/kanata.kbd"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "/tmp/kanata.log";
        StandardErrorPath = "/tmp/kanata.log";
      };
    };
    
    # Add kanata to PATH for manual control
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "kanata-restart" ''
        launchctl unload ~/Library/LaunchAgents/com.bdsqqq.kanata.plist 2>/dev/null || true
        launchctl load ~/Library/LaunchAgents/com.bdsqqq.kanata.plist
        echo "Kanata restarted"
      '')
    ];
  };
}