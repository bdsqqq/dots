{
  config,
  lib,
  pkgs,
  hostSystem,
  ...
}:
let
  drive = builtins.fromJSON (builtins.readFile ./drive.json);
  checkout = "${config.my.paths.commonplace}/01_files/nix";
  liveModule = "${checkout}/modules/backup/ssd-01";
  cfg = config.my.ssd01Backup;
  inherit (import ./transport.nix { inherit config lib pkgs; }) passwordFile sshCommand;
  hook = action: arguments: ''
    #!/bin/sh
    exec ${pkgs.coreutils}/bin/env \
      ${lib.escapeShellArg "RESTIC_PASSWORD_FILE=${passwordFile}"} \
      ${lib.escapeShellArg "SSD_BACKUP_RESTIC=${pkgs.restic}/bin/restic"} \
      ${lib.escapeShellArg "SSD_BACKUP_TIMEOUT=${pkgs.coreutils}/bin/timeout"} \
      ${lib.escapeShellArg "SSD_BACKUP_SSH_KEY=${cfg.sshKeyPath}"} \
      ${lib.escapeShellArg "SSD_BACKUP_KNOWN_HOSTS=${cfg.knownHostsPath}"} \
      ${lib.escapeShellArg "SSD_BACKUP_SFTP_COMMAND=${sshCommand}"} \
      SSD_BACKUP_POLICY_SHA256=${builtins.hashString "sha256" (builtins.readFile ./drive.json)} \
      ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${liveModule}/hooks.ts"} ${action} ${arguments}
  '';
in
{
  imports = [ ./repository.nix ];

  config = {
    assertions = [
      {
        assertion = lib.hasInfix "darwin" hostSystem;
        message = "ssd-01-backup validates an APFS volume with macOS diskutil";
      }
    ];
    my.backup = {
      plans.ssd-01 = {
        # Only this plan owns drive gating; shared repository users remain independent.
        requirePaths = false;
        repository = drive.repository.id;
        inherit (drive) paths;
        excludes = [ "._*" ];
        schedule = {
          maxFrequencyHours = 24;
          clock = "CLOCK_LAST_RUN_TIME";
        };
        retention.policyKeepAll = true;
        skipIfUnchanged = true;
        backupFlags = [ "--one-file-system" ];
        hooks = [
          {
            conditions = [ "CONDITION_SNAPSHOT_START" ];
            onError = "ON_ERROR_CANCEL";
            actionCommand.command = hook "presence" "";
          }
          {
            conditions = [ "CONDITION_SNAPSHOT_START" ];
            onError = "ON_ERROR_FATAL";
            actionCommand.command = hook "prepare" "";
          }
          {
            conditions = [ "CONDITION_SNAPSHOT_SUCCESS" ];
            onError = "ON_ERROR_FATAL";
            actionCommand.command = hook "verify" "{{ .ShellEscape .SnapshotId }}";
          }
          {
            conditions = [
              "CONDITION_SNAPSHOT_ERROR"
              "CONDITION_SNAPSHOT_WARNING"
            ];
            onError = "ON_ERROR_IGNORE";
            actionCommand.command = hook "error" "{{ .ShellEscape .Error }}";
          }
        ];
      };
    };
  };
}
