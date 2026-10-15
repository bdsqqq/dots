{ config, lib, pkgs, ... }:
let
  drive = builtins.fromJSON (builtins.readFile ./drive.json);
  home = config.home-manager.users.${config.my.primaryUser}.home.homeDirectory;
  runtimePath = lib.types.addCheck lib.types.str
    (path: lib.hasPrefix "/" path && !lib.hasPrefix "/nix/store/" path);
  inherit (import ./transport.nix { inherit config lib pkgs; }) passwordFile sshCommand;
in
{
  # Sharing a destination must not import the removable drive's plan or hooks.
  imports = [ ../. ./credential.nix ];

  options.my.ssd01Backup = {
    sshKeyPath = lib.mkOption {
      type = runtimePath;
      default = "${home}/.ssh/id_ed25519";
      description = "existing host SSH identity; never provisioned or replaced by this module";
    };
    knownHostsPath = lib.mkOption {
      type = runtimePath;
      default = "${home}/.ssh/known_hosts";
      description = "existing trusted SSH hosts; readiness never enrolls or updates hosts";
    };
  };

  config = {
    my.restic.ssd01.credential.required = true;
    my.backup = {
      defaultRepository = lib.mkDefault drive.repository.id;
      repositories.${drive.repository.id} = {
        inherit (drive.repository) uri guid;
        inherit passwordFile;
        flags = [
          (lib.escapeShellArgs [
            "-o"
            "sftp.command=${sshCommand}"
          ])
        ];
        prunePolicy.schedule.disabled = true;
        checkPolicy = {
          schedule.maxFrequencyDays = 7;
          readDataSubsetPercent = 5;
        };
        autoUnlock = true;
        autoInitialize = false;
      };
    };
  };
}
