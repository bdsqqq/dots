{ config
, lib
, pkgs
, ...
}:

let
  cfg = config.my.backrest;
  home = cfg.homeDirectory;
  backrestConfigDir = "${home}/.config/backrest";
  backrestDataDir = "${home}/.local/share/backrest";
  resticSecret = "${home}/commonplace/01_files/nix/restic/secrets.yaml";
  sopsAgeKey = "${home}/.config/sops/age/keys.txt";
  storageBoxKey = "${home}/.ssh/id_ed25519";
  resticPasswordCommand = "${pkgs.coreutils}/bin/env SOPS_AGE_KEY_FILE=${sopsAgeKey} ${pkgs.sops}/bin/sops --decrypt --extract '[\"restic_ssd_01_password\"]' ${resticSecret}";
  backupCanaryPath = "${cfg.volumeRoot}/igor/.backup-restore-canary";
  backupCanary = pkgs.writeText "ssd-01-backup-restore-canary" ''
    ssd-01 restore verification v1
  '';

  backupFailureNotification = ''
    #!/bin/sh
    /usr/bin/osascript -e 'display notification "Open Backrest for details." with title "ssd-01 backup needs attention" sound name "Basso"'
  '';

  backupSuccessNotification = ''
    #!/bin/sh
    /usr/bin/osascript -e 'display notification "The encrypted off-site snapshot completed." with title "ssd-01 backup complete"'
  '';

  ssdMountGuard = ''
    #!/bin/sh
    set -eu

    actual_uuid="$(/usr/sbin/diskutil info -plist ${lib.escapeShellArg cfg.volumeRoot} | /usr/bin/plutil -extract VolumeUUID raw -o - -)"
    if [ "$actual_uuid" = ${lib.escapeShellArg cfg.volumeUuid} ] \
      && [ -d ${lib.escapeShellArg "${cfg.volumeRoot}/fenfe"} ] \
      && [ -d ${lib.escapeShellArg "${cfg.volumeRoot}/igor"} ] \
      && [ -f ${lib.escapeShellArg "${cfg.volumeRoot}/igor/photos-library-2/.osxphotos_export.db"} ]; then
      /usr/bin/cmp -s ${backupCanary} ${lib.escapeShellArg backupCanaryPath} \
        || /usr/bin/install -m 0444 ${backupCanary} ${lib.escapeShellArg backupCanaryPath}
      exit 0
    fi

    ${backupFailureNotification}
    exit 1
  '';

  restoreVerification = ''
    #!/bin/sh
    set -eu

    restore_dir="$(/usr/bin/mktemp -d)"
    trap '/bin/rm -rf "$restore_dir"' EXIT
    snapshot={{ .ShellEscape .SnapshotId }}
    export RESTIC_PASSWORD_COMMAND=${lib.escapeShellArg resticPasswordCommand}

    if ${pkgs.restic}/bin/restic \
      -r ${lib.escapeShellArg cfg.repository.uri} \
      -o ${lib.escapeShellArg "sftp.command=${pkgs.openssh}/bin/ssh -p ${toString cfg.repository.sshPort} -o BatchMode=yes -o IdentitiesOnly=yes -i ${storageBoxKey} ${cfg.repository.sshTarget} -s sftp"} \
      restore "$snapshot" \
      --include ${lib.escapeShellArg backupCanaryPath} \
      --target "$restore_dir" \
      && /usr/bin/cmp -s ${backupCanary} "$restore_dir${backupCanaryPath}"; then
      ${backupSuccessNotification}
      exit 0
    fi

    ${backupFailureNotification}
    exit 1
  '';

  managedBackrestConfig = {
    repos = [
      {
        id = cfg.repository.id;
        uri = cfg.repository.uri;
        guid = cfg.repository.guid;
        password = "";
        env = [
          "RESTIC_PASSWORD_COMMAND=${resticPasswordCommand}"
        ];
        flags = [
          "-o 'sftp.args=-p ${toString cfg.repository.sshPort} -oBatchMode=yes -oIdentitiesOnly=yes -i ${storageBoxKey}'"
        ];
        prunePolicy.schedule.disabled = true;
        checkPolicy = {
          schedule.maxFrequencyDays = 7;
          readDataSubsetPercent = 5;
        };
        autoUnlock = true;
        autoInitialize = false;
        hooks = [ ];
      }
    ];
    plans = [
      {
        id = "ssd-01";
        repo = cfg.repository.id;
        paths = [
          "${cfg.volumeRoot}/fenfe"
          "${cfg.volumeRoot}/igor"
        ];
        excludes = [ "._*" ];
        iexcludes = [ ];
        schedule = {
          maxFrequencyHours = 24;
          clock = "CLOCK_LAST_RUN_TIME";
        };
        retention.policyKeepAll = true;
        hooks = [
          {
            conditions = [ "CONDITION_SNAPSHOT_START" ];
            onError = "ON_ERROR_CANCEL";
            actionCommand.command = ssdMountGuard;
          }
          {
            conditions = [ "CONDITION_SNAPSHOT_SUCCESS" ];
            onError = "ON_ERROR_FATAL";
            actionCommand.command = restoreVerification;
          }
          {
            conditions = [ "CONDITION_SNAPSHOT_ERROR" ];
            onError = "ON_ERROR_IGNORE";
            actionCommand.command = backupFailureNotification;
          }
        ];
        backup_flags = [
          "--host ${config.networking.localHostName}"
          "--one-file-system"
        ];
        skipIfUnchanged = true;
      }
    ];
  };

  backrestManagedConfig = pkgs.writeText "backrest-managed.json" (
    builtins.toJSON managedBackrestConfig
  );

  backrestInitialConfig = pkgs.writeText "backrest-initial.json" (
    builtins.toJSON (
      managedBackrestConfig
      // {
        modno = 1;
        version = 6;
        instance = config.networking.localHostName;
        auth = {
          disabled = true;
          users = [ ];
        };
      }
    )
  );

  backrestServer = pkgs.writeShellApplication {
    name = "backup-health-server";
    runtimeInputs = [
      pkgs.backrest
      pkgs.coreutils
      pkgs.jq
      pkgs.openssh
      pkgs.restic
      pkgs.sops
    ];
    text = ''
      cleanup() {
        if [[ -n "''${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
          kill "$server_pid"
          wait "$server_pid" 2>/dev/null || true
        fi
      }
      trap cleanup EXIT
      trap 'exit 143' TERM
      trap 'exit 130' INT

      mkdir -p \
        ${lib.escapeShellArg backrestConfigDir} \
        ${lib.escapeShellArg backrestDataDir}

      config_file=${lib.escapeShellArg "${backrestConfigDir}/config.json"}
      if [[ -e "$config_file" ]]; then
        config_tmp="$(mktemp "${backrestConfigDir}/config.json.XXXXXX")"
        jq --slurpfile managed ${backrestManagedConfig} '
          $managed[0] as $managed
          | .repos = (
              ((.repos // []) | map(select(.id != $managed.repos[0].id)))
              + $managed.repos
            )
          | .plans = (
              ((.plans // []) | map(select(.id != $managed.plans[0].id)))
              + $managed.plans
            )
        ' "$config_file" > "$config_tmp"
        install -m 0600 "$config_tmp" "$config_file"
        rm -f "$config_tmp"
      else
        install -m 0600 ${backrestInitialConfig} "$config_file"
      fi

      backrest \
        -bind-address 127.0.0.1:9898 \
        -config-file "$config_file" \
        -data-dir ${lib.escapeShellArg backrestDataDir} \
        -restic-cmd ${pkgs.restic}/bin/restic &
      server_pid=$!

      wait "$server_pid"
    '';
  };
in
{
  options.my.backrest = {
    homeDirectory = lib.mkOption {
      type = lib.types.str;
      description = "home directory that owns Backrest state and credentials";
    };
    volumeRoot = lib.mkOption {
      type = lib.types.str;
      description = "mounted volume root protected by the backup plan";
    };
    volumeUuid = lib.mkOption {
      type = lib.types.str;
      description = "expected volume UUID checked before each snapshot";
    };
    repository = {
      id = lib.mkOption {
        type = lib.types.str;
        description = "Backrest repository identifier";
      };
      uri = lib.mkOption {
        type = lib.types.str;
        description = "Restic repository URI";
      };
      guid = lib.mkOption {
        type = lib.types.str;
        description = "Backrest repository GUID";
      };
      sshTarget = lib.mkOption {
        type = lib.types.str;
        description = "SSH target used for Restic's SFTP transport";
      };
      sshPort = lib.mkOption {
        type = lib.types.port;
        default = 22;
        description = "SSH port used for Restic's SFTP transport";
      };
    };
  };

  config = {
    my.tailnetRegistry.services.backup-health = {
      title = "backrest";
      description = "daily encrypted ssd-01 backups with data and restore verification";
      target = "http://127.0.0.1:9898";
      scheme = "https";
      port = 9898;
      healthPath = "/";
      access.tailnet = "owner";
      adoptExisting = true;
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ backrestServer ];

      home.activation.backrestState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p \
          ${lib.escapeShellArg backrestConfigDir} \
          ${lib.escapeShellArg backrestDataDir}
      '';

      launchd.agents.backup-health = {
        enable = true;
        config = {
          ProgramArguments = [ "${backrestServer}/bin/backup-health-server" ];
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/backup-health.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/backup-health.log";
        };
      };
    };
  };
}
