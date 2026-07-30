{
  config,
  lib,
  pkgs,
  hostSystem ? null,
  ...
}:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  commonplace = config.my.paths.commonplace;
  script = pkgs.writeText "syncthing-automerge.ts" (builtins.readFile ./syncthing-automerge.ts);
  package = pkgs.writeShellApplication {
    name = "syncthing-automerge";
    runtimeInputs = [
      pkgs.git
      pkgs.nodejs
    ];
    text = ''
      exec node ${script} "$@"
    '';
  };
in
{
  home-manager.users.bdsqqq =
    { config, ... }:
    {
      home.packages = [ package ];

      launchd.agents.syncthing-automerge = lib.mkIf isDarwin {
        enable = true;
        config = {
          ProgramArguments = [ "${package}/bin/syncthing-automerge" ];
          WorkingDirectory = commonplace;
          RunAtLoad = true;
          KeepAlive = true;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/syncthing-automerge.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/syncthing-automerge.log";
        };
      };
    };
}
// lib.optionalAttrs isLinux {
  systemd.services.syncthing-automerge = {
    description = "Automatically merge Syncthing conflict files";
    after = [ "syncthing.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = "${package}/bin/syncthing-automerge";
      User = "bdsqqq";
      Group = "users";
      WorkingDirectory = commonplace;
      Restart = "on-failure";
      RestartSec = "10s";
    };
  };
}
