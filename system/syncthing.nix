{ lib, pkgs, ... }:
{
  services = lib.mkIf pkgs.stdenv.isLinux {
    syncthing = {
      enable = true;
      user = "bdsqqq";
      dataDir = "/home/bdsqqq";
      configDir = "/home/bdsqqq/.config/syncthing";
    };
  };

  launchd = lib.mkIf pkgs.stdenv.isDarwin {
    user.agents.syncthing = {
      serviceConfig = {
        Label = "com.bdsqqq.syncthing";
        ProgramArguments = [
          "${pkgs.syncthing}/bin/syncthing"
          "-no-browser"
          "-home"
          "/Users/bdsqqq/.config/syncthing"
        ];
        WorkingDirectory = "/Users/bdsqqq";
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "/Users/bdsqqq/Library/Logs/syncthing.log";
        StandardErrorPath = "/Users/bdsqqq/Library/Logs/syncthing.log";
      };
    };
  };
}


