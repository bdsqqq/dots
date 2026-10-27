{ inputs
, config
, pkgs
, lib
, ...
}:
let
  syncthing = import ../../modules/syncthing/lib.nix { inherit lib; };
  home = "/Users/bdsqqq";
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
    ../../modules/primary-user.nix
    ../../modules/agent-decoy
    ../../modules/auto-login
    ../../modules/nix
    ../../modules/secrets
    ../../modules/homebrew/best-effort.nix
    ../../modules/tailscale
    ../../modules/tailnet-registry
    ../../modules/syncthing
    ../../modules/terraria-sync
    ../../modules/sleepless
    ../../modules/fonts
    ../../modules/core-cli
    ../../modules/shell
    ../../modules/ssh/client.nix
    ../../modules/ssh/authorized-keys.nix
    ../../modules/btop
    ../../modules/homebrew/environment.nix
    ../../modules/depot
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
    ../../modules/gog
    ../../modules/wacli
    ../../modules/goplaces
    ../../modules/openhue
    ../../modules/xurl
    ../../modules/weather
    ../../modules/remindctl
    ../../modules/node-pnpm
    ../../modules/1password
    ../../modules/orbstack
    ../../modules/ghostty
    ../../modules/rex
    ../../modules/open-display
    ../../modules/obsidian
    ../../modules/html-stuff
    ../../modules/media-feeds
    ../../modules/backup/ssd-01
    ../../modules/backup/terraria
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

  my.backup.terraria.saveRoot = config.my.terrariaSync.saveRoot;

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
