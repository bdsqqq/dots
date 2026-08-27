{ config, lib, pkgs, ... }:
let
  cfg = config.my.photoIntelligence;
  server = import ./package.nix { inherit pkgs; };
  sentinel = "${cfg.source}/.osxphotos_export.db";
  launcher = pkgs.writeShellScript "photo-intelligence-launcher" ''
    set -eu

    while [ ! -d ${lib.escapeShellArg cfg.source} ] \
      || [ ! -f ${lib.escapeShellArg sentinel} ]; do
      echo "waiting for photo source: ${cfg.source}" >&2
      ${pkgs.coreutils}/bin/sleep 15
    done

    exec ${server}/bin/photo-intelligence-server \
      --source ${lib.escapeShellArg cfg.source} \
      --state ${lib.escapeShellArg cfg.state} \
      --sentinel .osxphotos_export.db \
      --port 3924
  '';
in
{
  options.my.photoIntelligence = {
    source = lib.mkOption {
      type = lib.types.str;
      description = "photo library indexed by the intelligence service";
    };
    state = lib.mkOption {
      type = lib.types.str;
      description = "private index state directory";
    };
  };

  config.home-manager.users.bdsqqq = { config, lib, ... }: {
    home.packages = [ server ];
    home.activation.photoIntelligenceState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg cfg.state}
    '';

    launchd.agents.photo-intelligence = {
      enable = true;
      config = {
        ProgramArguments = [
          "${launcher}"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/photo-intelligence.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/photo-intelligence.log";
      };
    };
  };
}
