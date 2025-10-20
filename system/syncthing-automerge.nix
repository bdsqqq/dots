{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in
if isDarwin then {
  # Darwin implementation with launchd
  environment.etc."syncthing-automerge/syncthing-automerge.py".source = ../scripts/syncthing-automerge.py;
  environment.systemPackages = [ pkgs.uv
    (pkgs.writeShellScriptBin "syncthing-automerge-status" ''
      echo "Syncthing Automerge Service Status:"
      launchctl print gui/$(id -u)/com.bdsqqq.syncthing-automerge 2>/dev/null || echo "Service not loaded"
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-start" ''
      echo "Starting syncthing automerge service..."
      launchctl load -w ~/Library/LaunchAgents/com.bdsqqq.syncthing-automerge.plist
      echo "Service started."
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-stop" ''
      echo "Stopping syncthing automerge service..."
      launchctl unload ~/Library/LaunchAgents/com.bdsqqq.syncthing-automerge.plist
      echo "Service stopped."
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-restart" ''
      echo "Restarting syncthing automerge service..."
      launchctl unload ~/Library/LaunchAgents/com.bdsqqq.syncthing-automerge.plist 2>/dev/null || true
      sleep 1
      launchctl load -w ~/Library/LaunchAgents/com.bdsqqq.syncthing-automerge.plist
      echo "Service restarted."
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-logs" ''
      echo "Syncthing Automerge Logs (press Ctrl+C to exit):"
      tail -f ~/Library/Logs/syncthing-automerge.log
    '')
  ];
  
  launchd.user.agents.syncthing-automerge = {
    serviceConfig = {
      Label = "com.bdsqqq.syncthing-automerge";
      ProgramArguments = [
        "${pkgs.uv}/bin/uv"
        "run"
        "--script"
        "/etc/syncthing-automerge/syncthing-automerge.py"
      ];
      WorkingDirectory = "/Users/bdsqqq/commonplace";
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/Users/bdsqqq/Library/Logs/syncthing-automerge.log";
      StandardErrorPath = "/Users/bdsqqq/Library/Logs/syncthing-automerge.log";
    };
  };
} else if isLinux then {
  # Linux implementation with systemd
  environment.etc."syncthing-automerge/syncthing-automerge.py".source = ../scripts/syncthing-automerge.py;
  environment.systemPackages = [ pkgs.uv
    (pkgs.writeShellScriptBin "syncthing-automerge-status" ''
      systemctl --user status syncthing-automerge.service
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-start" ''
      systemctl --user start syncthing-automerge.service
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-stop" ''
      systemctl --user stop syncthing-automerge.service
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-restart" ''
      systemctl --user restart syncthing-automerge.service
    '')
    (pkgs.writeShellScriptBin "syncthing-automerge-logs" ''
      journalctl --user -u syncthing-automerge.service -f
    '')
  ];
  
  systemd.user.services.syncthing-automerge = {
    description = "Syncthing auto-merge conflicts service";
    after = [ "syncthing.service" ];
    wantedBy = [ "default.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.uv}/bin/uv run --script /etc/syncthing-automerge/syncthing-automerge.py";
      WorkingDirectory = "/home/bdsqqq/commonplace";
      Restart = "on-failure";
      RestartSec = "10s";
    };
  };
} else {}
