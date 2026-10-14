{
  config,
  lib,
  pkgs,
  hostSystem,
  ...
}:
let
  drive = builtins.fromJSON (builtins.readFile ./drive.json);
  home = config.home-manager.users.${config.my.primaryUser}.home.homeDirectory;
  checkout = "${config.my.paths.commonplace}/01_files/nix";
  liveModule = "${checkout}/modules/ssd-01-backup";
  storageBoxKey = "${home}/.ssh/id_ed25519";
  passwordCommand = lib.escapeShellArgs [
    "${pkgs.coreutils}/bin/env"
    "SOPS_AGE_KEY_FILE=${home}/.config/sops/age/keys.txt"
    "${pkgs.sops}/bin/sops"
    "--decrypt"
    "--extract"
    ''["restic_ssd_01_password"]''
    "${checkout}/restic/secrets.yaml"
  ];
  sshCommand = lib.escapeShellArgs [
    "${pkgs.openssh}/bin/ssh"
    "-p"
    (toString drive.repository.sshPort)
    "-o"
    "BatchMode=yes"
    "-o"
    "IdentitiesOnly=yes"
    "-i"
    storageBoxKey
    drive.repository.sshTarget
    "-s"
    "sftp"
  ];
  hook = action: arguments: ''
    #!/bin/sh
    exec ${pkgs.coreutils}/bin/env \
      ${lib.escapeShellArg "RESTIC_PASSWORD_COMMAND=${passwordCommand}"} \
      ${lib.escapeShellArg "SSD_BACKUP_RESTIC=${pkgs.restic}/bin/restic"} \
      ${lib.escapeShellArg "SSD_BACKUP_SFTP_COMMAND=${sshCommand}"} \
      ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${liveModule}/hooks.ts"} ${action} ${arguments}
  '';
in
{
  imports = [ ../backup ];

  config = {
    assertions = [
      {
        assertion = lib.hasInfix "darwin" hostSystem;
        message = "ssd-01-backup validates an APFS volume with macOS diskutil";
      }
    ];
    my.backup = {
      defaultRepository = lib.mkDefault drive.repository.id;
      repositories.${drive.repository.id} = {
        inherit (drive.repository) uri guid;
        inherit passwordCommand;
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
