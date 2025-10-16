{ lib, pkgs, ... }:
{
  services = lib.optionalAttrs pkgs.stdenv.isLinux {
    syncthing = {
      enable = true;
      user = "bdsqqq";
      dataDir = "/home/bdsqqq";
      configDir = "/home/bdsqqq/.config/syncthing";
    };
  };

  launchd.user.agents = lib.optionalAttrs pkgs.stdenv.isDarwin {
    syncthing = {
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


