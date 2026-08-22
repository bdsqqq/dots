{ config
, lib
, pkgs
, ...
}:

let
  home = "/Users/bdsqqq";
  galleryRoot = "/Volumes/ssd-01/igor/photos-library-2";
  copypartyCache = "${home}/Library/Caches/copyparty-ssd";
  photoIntelligenceState = "${home}/Library/Application Support/photo-intelligence";
  filesBrowserCache = "${home}/Library/Caches/copyparty-files";
  syncthingConfig = "${home}/Library/Application Support/Syncthing/config.xml";
  backrestConfigDir = "${home}/.config/backrest";
  backrestDataDir = "${home}/.local/share/backrest";
  resticSecret = "${home}/commonplace/01_files/nix/restic/secrets.yaml";
  sopsAgeKey = "${home}/.config/sops/age/keys.txt";
  storageBoxKey = "${home}/.ssh/id_ed25519";
  resticPasswordCommand = "${pkgs.coreutils}/bin/env SOPS_AGE_KEY_FILE=${sopsAgeKey} ${pkgs.sops}/bin/sops --decrypt --extract '[\"restic_ssd_01_password\"]' ${resticSecret}";
  ssdVolumeUuid = "967C80B3-674A-3C8C-A248-2E6B8230DFD7";
  backupCanaryPath = "/Volumes/ssd-01/igor/.backup-restore-canary";
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

    actual_uuid="$(/usr/sbin/diskutil info -plist /Volumes/ssd-01 | /usr/bin/plutil -extract VolumeUUID raw -o - -)"
    if [ "$actual_uuid" = ${lib.escapeShellArg ssdVolumeUuid} ] \
      && [ -d /Volumes/ssd-01/fenfe ] \
      && [ -d /Volumes/ssd-01/igor ] \
      && [ -f /Volumes/ssd-01/igor/photos-library-2/.osxphotos_export.db ]; then
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
      -r sftp:u646875@u646875.your-storagebox.de:/home/restic/ssd-01 \
      -o ${lib.escapeShellArg "sftp.command=${pkgs.openssh}/bin/ssh -p 23 -o BatchMode=yes -o IdentitiesOnly=yes -i ${storageBoxKey} u646875@u646875.your-storagebox.de -s sftp"} \
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
        id = "ssd-01-hetzner";
        uri = "sftp:u646875@u646875.your-storagebox.de:/home/restic/ssd-01";
        guid = "db9719f847da679dbbbdca1d9cbe716f1c462fa23966d5abdcf1cf0a04ad0993";
        password = "";
        env = [
          "RESTIC_PASSWORD_COMMAND=${resticPasswordCommand}"
        ];
        flags = [
          "-o 'sftp.args=-p 23 -oBatchMode=yes -oIdentitiesOnly=yes -i ${storageBoxKey}'"
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
        repo = "ssd-01-hetzner";
        paths = [
          "/Volumes/ssd-01/fenfe"
          "/Volumes/ssd-01/igor"
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

  photoGalleryServer = import ../modules/photo-gallery { inherit pkgs; };
  photoIntelligenceServer = import ../modules/photo-intelligence { inherit pkgs; };
  filesBrowserServer = import ../modules/files-browser { inherit pkgs; };

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
  my.tailnetRegistry.providers = {
    files = {
      target = "http://127.0.0.1:3925";
      scheme = "https";
      port = 3925;
      healthPath = "/";
    };

    photos = {
      target = "http://127.0.0.1:3923";
      scheme = "https";
      port = 3923;
      path = "/gallery/";
      healthPath = "/gallery/";
      adoptExisting = true;
    };
  };

  my.tailnetRegistry.services = {
    backup-health = {
      title = "backrest";
      description = "daily encrypted ssd-01 backups with data and restore verification";
      target = "http://127.0.0.1:9898";
      scheme = "https";
      port = 9898;
      healthPath = "/";
      access.tailnet = "owner";
      adoptExisting = true;
    };
  };

  home-manager.users.bdsqqq = { config, lib, ... }: {
    home.packages = [
      backrestServer
      filesBrowserServer
      photoGalleryServer
      photoIntelligenceServer
    ];

    home.activation.storagePreviewState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p \
        ${lib.escapeShellArg backrestConfigDir} \
        ${lib.escapeShellArg backrestDataDir} \
        ${lib.escapeShellArg copypartyCache} \
        ${lib.escapeShellArg filesBrowserCache}
      ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg photoIntelligenceState}
    '';

    launchd.agents.files-browser = {
      enable = true;
      config = {
        ProgramArguments = [
          "${filesBrowserServer}/bin/files-browser-server"
          "--source"
          "${home}/commonplace"
          "--state"
          filesBrowserCache
          "--syncthing-config"
          syncthingConfig
          "--syncthing-url"
          "http://127.0.0.1:8384"
          "--port"
          "3925"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/files-browser.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/files-browser.log";
      };
    };

    launchd.agents.ssd-gallery = {
      enable = true;
      config = {
        ProgramArguments = [
          "${photoGalleryServer}/bin/photo-gallery-server"
          "--source"
          galleryRoot
          "--state"
          copypartyCache
          "--port"
          "3923"
          "--intelligence-url"
          "http://127.0.0.1:3924"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/ssd-gallery.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/ssd-gallery.log";
      };
    };

    launchd.agents.photo-intelligence = {
      enable = true;
      config = {
        ProgramArguments = [
          "${photoIntelligenceServer}/bin/photo-intelligence-server"
          "--source"
          galleryRoot
          "--state"
          photoIntelligenceState
          "--sentinel"
          ".osxphotos_export.db"
          "--port"
          "3924"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/photo-intelligence.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/photo-intelligence.log";
      };
    };

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
}
