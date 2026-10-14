{ inputs
, config
, pkgs
, lib
, ...
}:
let
  syncthing = import ../../modules/syncthing/lib.nix { inherit lib; };
  home = "/Users/bdsqqq";
  ssd = {
    volumeRoot = "/Volumes/ssd-01";
    volumeUuid = "967C80B3-674A-3C8C-A248-2E6B8230DFD7";
    repository = {
      id = "ssd-01-hetzner";
      uri = "sftp:u646875@u646875.your-storagebox.de:/home/restic/ssd-01";
      guid = "db9719f847da679dbbbdca1d9cbe716f1c462fa23966d5abdcf1cf0a04ad0993";
      sshTarget = "u646875@u646875.your-storagebox.de";
      sshPort = 23;
    };
  };
  resticSecret = "${home}/commonplace/01_files/nix/restic/secrets.yaml";
  sopsAgeKey = "${home}/.config/sops/age/keys.txt";
  storageBoxKey = "${home}/.ssh/id_ed25519";
  resticPasswordCommand = "${pkgs.coreutils}/bin/env SOPS_AGE_KEY_FILE=${sopsAgeKey} ${pkgs.sops}/bin/sops --decrypt --extract '[\"restic_ssd_01_password\"]' ${resticSecret}";
  backupCanaryPath = "${ssd.volumeRoot}/igor/.backup-restore-canary";
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

    actual_uuid="$(/usr/sbin/diskutil info -plist ${lib.escapeShellArg ssd.volumeRoot} | /usr/bin/plutil -extract VolumeUUID raw -o - -)"
    if [ "$actual_uuid" = ${lib.escapeShellArg ssd.volumeUuid} ] \
      && [ -d ${lib.escapeShellArg "${ssd.volumeRoot}/fenfe"} ] \
      && [ -d ${lib.escapeShellArg "${ssd.volumeRoot}/igor"} ] \
      && [ -f ${lib.escapeShellArg "${ssd.volumeRoot}/igor/photos-library-2/.osxphotos_export.db"} ]; then
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
      -r ${lib.escapeShellArg ssd.repository.uri} \
      -o ${lib.escapeShellArg "sftp.command=${pkgs.openssh}/bin/ssh -p ${toString ssd.repository.sshPort} -o BatchMode=yes -o IdentitiesOnly=yes -i ${storageBoxKey} ${ssd.repository.sshTarget} -s sftp"} \
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
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
    ../../modules/primary-user.nix
    ../../modules/auto-login
    ../../modules/nix
    ../../modules/secrets
    ../../modules/homebrew/best-effort.nix
    ../../modules/tailscale
    ../../modules/tailnet-registry
    ../../modules/fleet-mesh
    ../../modules/syncthing
    ../../modules/terraria-sync
    ../../modules/sleepless
    ../../modules/cmux
    ../../modules/fonts
    ../../modules/core-cli
    ../../modules/shell
    ../../modules/ssh/client.nix
    ../../modules/ssh/authorized-keys.nix
    ../../modules/btop
    ../../modules/homebrew/environment.nix
    ../../modules/fzf
    ../../modules/zoxide
    ../../modules/nvim
    ../../modules/git
    ../../modules/tealdeer
    ../../modules/trash
    (import ../../modules/zmx).module
    ../../modules/direnv
    ../../modules/tmux
    ../../modules/darwin-transcription
    ../../modules/agents
    ../../modules/node-pnpm
    ../../modules/1password
    ../../modules/orbstack
    ../../modules/ghostty
    ../../modules/open-display
    ../../modules/obsidian
    ../../modules/html-stuff
    ../../modules/media-feeds
    ../../modules/backup
    ../../modules/files-browser/service.nix
    ../../modules/photo-gallery/service.nix
    ../../modules/photo-intelligence/service.nix
    ../../modules/hue-control
    ../../modules/hue-homekit
  ];

  networking = {
    hostName = "mmn-m4.local";
    localHostName = "mmn-m4";
    computerName = "mmn-m4";
  };

  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";
  my.primaryUser = "bdsqqq";
  my.openDisplay = {
    launchAtLogin = true;
    wifiServiceName = "iPad";
  };
  power = {
    restartAfterPowerFailure = true;
    sleep = {
      computer = "never";
      display = "never";
    };
  };

  my.filesBrowser = {
    source = "/Users/bdsqqq/commonplace";
    state = "/Users/bdsqqq/Library/Caches/copyparty-files";
    syncthingConfig = "/Users/bdsqqq/Library/Application Support/Syncthing/config.xml";
  };
  my.photoGallery = {
    source = "/Volumes/ssd-01/igor/photos-library-2";
    state = "/Users/bdsqqq/Library/Caches/copyparty-ssd";
  };
  my.photoIntelligence = {
    source = "/Volumes/ssd-01/igor/photos-library-2";
    state = "/Users/bdsqqq/Library/Application Support/photo-intelligence";
  };
  my.darwinTranscription.enable = true;
  my.hueControl = {
    enable = true;
    publishService = true;
  };
  my.hueHomekit = {
    enable = true;
    interface = "en1";
    additionalBridges.wife = {
      name = "Desk Light Second Home";
      port = 51827;
    };
  };
  my.backup = {
    defaultRepository = lib.mkDefault ssd.repository.id;
    repositories.${ssd.repository.id} = {
      uri = ssd.repository.uri;
      guid = ssd.repository.guid;
      passwordCommand = resticPasswordCommand;
      flags = [
        "-o 'sftp.args=-p ${toString ssd.repository.sshPort} -oBatchMode=yes -oIdentitiesOnly=yes -i ${storageBoxKey}'"
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
      # this plan's mount guard owns source validation and its notification.
      requirePaths = false;
      repository = ssd.repository.id;
      paths = [
        "${ssd.volumeRoot}/fenfe"
        "${ssd.volumeRoot}/igor"
      ];
      excludes = [ "._*" ];
      schedule = { maxFrequencyHours = 24; clock = "CLOCK_LAST_RUN_TIME"; };
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
      backupFlags = [
        "--one-file-system"
      ];
      skipIfUnchanged = true;
    };
  };
  # keep the existing service id; one endpoint exposes every backrest plan.
  my.tailnetRegistry.services.backup-health = {
    title = "backrest";
    description = "ssd-01 and terraria backups";
    target = "http://${config.my.backup.bindAddress}";
    scheme = "https";
    port = 9898;
    healthPath = "/";
    access.tailnet = "owner";
    adoptExisting = true;
  };

  my.terrariaSync = {
    enable = true;
    saveRoot = "/Users/bdsqqq/.local/share/terraria-saves";
    type = "receiveonly";
    devices = [ "mbp-m2" "ipd" ];
  };

  my.backup.plans.terraria = {
    paths = [
      "${config.my.terrariaSync.saveRoot}/Players"
      "${config.my.terrariaSync.saveRoot}/Worlds"
    ];
    schedule = { maxFrequencyHours = 1; clock = "CLOCK_LAST_RUN_TIME"; };
    excludes = [ ".stfolder" ".stversions" ];
  };

  environment.systemPackages = [ pkgs.git ];

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
      headMode = "graphical";
    };
    users.bdsqqq = {
      home = {
        username = "bdsqqq";
        homeDirectory = "/Users/bdsqqq";
        stateVersion = "25.05";
      };
      programs.home-manager.enable = true;

      services.syncthing = {
        enable = true;
        overrideFolders = true;
        overrideDevices = true;
        guiAddress = "127.0.0.1:8384";
        settings = {
          options = {
            urAccepted = -1;
            globalAnnounceEnabled = false;
            localAnnounceEnabled = false;
            relaysEnabled = false;
            natEnabled = false;
          };
          devices =
            (syncthing.devicesFor [
              "mbp-m2"
              "mbp-m5"
              "htz-relay"
            ])
            // {
              mbp-m2 = syncthing.devices.mbp-m2 // {
                introducer = false;
              };
            };
          folders = {
            commonplace = syncthing.folderForPath "commonplace" "/Users/bdsqqq/commonplace" [
              "mbp-m2"
              "mbp-m5"
              "htz-relay"
            ]
              { label = "commonplace"; };
            kindle = syncthing.folderFor "kindle" "/Users/bdsqqq" true [ "mbp-m2" ] { };
          };
        };
      };

      launchd.agents = {
        backup-health.domain = "user";
        files-browser.domain = "user";
        fleet-mesh-mmn-m4.domain = "user";
        fleet-mesh-relay.domain = "user";
        fleet-mesh-virtual-esp32.domain = "user";
        html-stuff.domain = "user";
        media-feed-import-modulo.domain = "user";
        media-feed-poller.domain = "user";
        photo-intelligence.domain = "user";
        ssd-gallery.domain = "user";
        syncthing.domain = "user";
        syncthing-init.domain = "user";
        transmission-daemon.domain = "user";
      };

    };
  };

  homebrew = {
    enable = true;
    casks = [
      "cleanshot"
      "raycast"
      "tableplus"
      "tailscale-app"
      "transmission"
    ];
    onActivation = {
      autoUpdate = false;
      upgrade = true;
    };
  };

  my.tailnetRegistry.directory = {
    enable = true;
    tailscaleService.enable = true;
  };
  my.fleetMesh = {
    enable = true;
    authority = {
      id = "fleet-admin";
      publicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJvCiyp+31mkd6AkLv8z8TfTZd4Scd/iCqHo2qCy/dhI=\n-----END PUBLIC KEY-----\n";
    };
    roster = [
      {
        id = "mmn-m4";
        signingPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6a737oiTfFZpFNVZ4nAMcnDDKJLEqmVTpuIY5l7OTfY=\n-----END PUBLIC KEY-----\n";
        encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAVqYfbya+KJEf8PQtiMc3+v51vWo0cngP+3Xj+tccnlw=\n-----END PUBLIC KEY-----\n";
      }
      {
        id = "relay";
        signingPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEADbanwhNFTi9/KIlLBPkON/iYTAlwcgbC8k9swFIN6qo=\n-----END PUBLIC KEY-----\n";
        encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAxSkUr3WkzBe0Sbs1YvGfrGZDzsw0vwi48MwHGwMu11c=\n-----END PUBLIC KEY-----\n";
      }
      {
        id = "virtual-esp32";
        signingPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAQ53zLO6hz6y04PB1jQEyLpEGC/w9m9rwUucbvSIy79s=\n-----END PUBLIC KEY-----\n";
        encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAvSWKMuD2FRRMY9FV0zp6E5493qc54cl1EAUccNPgBRc=\n-----END PUBLIC KEY-----\n";
      }
      {
        id = "esp32-sim-1";
        signingPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVkfLyPlkJWBfWlTP3P9dgNxFs9GcCDTZzoA7dY7Ec08=\n-----END PUBLIC KEY-----\n";
        encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAHQRrpphDj/ErtbRDH4hN8DcTwLNEnTAihxzvmsgoyxA=\n-----END PUBLIC KEY-----\n";
      }
      {
        id = "esp32-sim-2";
        signingPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAX986rEB/IpeJHLtfT3KPyQc+oZQsjkgt6Lulj3sVz8=\n-----END PUBLIC KEY-----\n";
        encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAzvn4hlPUo/HZThujLpj/3eFFUnbJCT36p13zGMAtnQU=\n-----END PUBLIC KEY-----\n";
      }
      {
        id = "esp32-sim-3";
        signingPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJ2R7nKLTn5H2Ol3lLgMLXD68AdAllMaXTkuX+PDAp/8=\n-----END PUBLIC KEY-----\n";
        encryptionPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEATpj+sgwNng5digkQRlOglz+wwNFoUCg8Po3TwoxIr3k=\n-----END PUBLIC KEY-----\n";
      }
    ];
    nodes = {
      mmn-m4 = {
        port = 43120;
        identitySecret = "fleet-mesh/bridge-identity";
        peers = [
          {
            id = "relay";
            url = "http://127.0.0.1:43121";
          }
        ];
      };
      relay = {
        port = 43121;
        identitySecret = "fleet-mesh/relay-identity";
        peers = [
          {
            id = "mmn-m4";
            url = "http://127.0.0.1:43120";
          }
          {
            id = "virtual-esp32";
            url = "http://127.0.0.1:43122";
          }
          {
            id = "esp32-sim-1";
            url = "http://127.0.0.1:43201";
          }
          {
            id = "esp32-sim-2";
            url = "http://127.0.0.1:43202";
          }
          {
            id = "esp32-sim-3";
            url = "http://127.0.0.1:43203";
          }
        ];
      };
      virtual-esp32 = {
        port = 43122;
        identitySecret = "fleet-mesh/virtual-esp32-identity";
        peers = [
          {
            id = "relay";
            url = "http://127.0.0.1:43121";
          }
        ];
      };
    };
    simulatedNodes = {
      esp32-sim-1 = {
        port = 43201;
        identitySecret = "fleet-mesh/esp32-sim-1-identity";
        peers = [
          {
            id = "relay";
            url = "http://10.0.2.2:43121";
          }
        ];
      };
      esp32-sim-2 = {
        port = 43202;
        identitySecret = "fleet-mesh/esp32-sim-2-identity";
        peers = [
          {
            id = "relay";
            url = "http://10.0.2.2:43121";
          }
        ];
      };
      esp32-sim-3 = {
        port = 43203;
        identitySecret = "fleet-mesh/esp32-sim-3-identity";
        peers = [
          {
            id = "relay";
            url = "http://10.0.2.2:43121";
          }
        ];
      };
    };
  };
  my.tailnetRegistry.hostChecks.syncthing = {
    enable = true;
    configFile = "${home}/Library/Application Support/Syncthing/config.xml";
    folderIds = [ syncthing.folderIds.commonplace ];
  };
  my.tailnetRegistry.darwinSystemDaemon = true;
  my.mediaFeeds = {
    enable = true;
    root = "/Users/bdsqqq/commonplace/03_media/one piece manga";
    polling.enable = true;
  };

  system.stateVersion = 6;
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };
}
