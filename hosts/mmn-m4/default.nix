{ config
, inputs
, pkgs
, lib
, ...
}:
let
  syncthing = import ../../modules/syncthing/lib.nix { inherit lib; };
  home = "/Users/bdsqqq";
  systemDaemonFromAgent = label: agentConfig: {
    serviceConfig = builtins.removeAttrs agentConfig [
      "GroupName"
      "Label"
      "LimitLoadToSessionType"
      "UserName"
    ] // {
      Label = label;
      UserName = "bdsqqq";
      GroupName = "staff";
      RunAtLoad = true;
      EnvironmentVariables.HOME = home;
    };
  };
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
    ../../modules/primary-user.nix
    ../../modules/nix
    ../../modules/secrets
    ../../modules/homebrew/best-effort.nix
    ../../modules/tailscale
    ../../modules/tailnet-registry
    ../../modules/syncthing
    ../../modules/o11y
    ../../modules/sleepless
    ../../modules/cmux
    ../../modules/fonts
    ../../modules/household-intake/service.nix
    ../../modules/core-cli
    ../../modules/shell
    ../../modules/ssh/client.nix
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
    ../../modules/amp
    ../../modules/agents
    ../../modules/node-pnpm
    ../../modules/1password
    ../../modules/orbstack
    ../../modules/ghostty
    ../../modules/ipad-display
    ../../modules/html-stuff
    ../../modules/media-feeds
    ../../modules/backrest
    ../../modules/files-browser/service.nix
    ../../modules/photo-gallery/service.nix
    ../../modules/photo-intelligence/service.nix
  ];

  networking = {
    hostName = "mmn-m4.local";
    localHostName = "mmn-m4";
    computerName = "mmn-m4";
  };

  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";
  my.primaryUser = "bdsqqq";

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
  my.backrest = {
    homeDirectory = "/Users/bdsqqq";
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
          devices = (syncthing.devicesFor [
            "mbp-m2"
            "htz-relay"
          ]) // {
            mbp-m2 = syncthing.devices.mbp-m2 // { introducer = false; };
          };
          folders = {
            commonplace = syncthing.folderForPath "commonplace" "/Users/bdsqqq/commonplace" [
              "mbp-m2"
              "htz-relay"
            ]
              { label = "commonplace"; };
            kindle = syncthing.folderFor "kindle" "/Users/bdsqqq" true [ "mbp-m2" ] { };
          };
        };
      };

      launchd.agents.syncthing.enable = lib.mkForce false;
      launchd.agents.syncthing-init.enable = lib.mkForce false;
      launchd.agents.files-browser.enable = lib.mkForce false;
      launchd.agents.html-stuff.enable = lib.mkForce false;
      launchd.agents.ssd-gallery.enable = lib.mkForce false;
      launchd.agents.backup-health.enable = lib.mkForce false;
      launchd.agents.transmission-daemon.enable = lib.mkForce false;
      launchd.agents.media-feed-import-modulo.enable = lib.mkForce false;
      launchd.agents.media-feed-poller.enable = lib.mkForce false;
      launchd.agents.photo-intelligence.enable = lib.mkForce false;
    };
  };

  launchd.daemons.backup-health = systemDaemonFromAgent
    "dev.backup-health"
    config.home-manager.users.bdsqqq.launchd.agents.backup-health.config;
  launchd.daemons.files-browser = systemDaemonFromAgent
    "dev.files-browser"
    config.home-manager.users.bdsqqq.launchd.agents.files-browser.config;
  launchd.daemons.html-stuff = systemDaemonFromAgent
    "dev.html-stuff"
    config.home-manager.users.bdsqqq.launchd.agents.html-stuff.config;
  launchd.daemons.media-feed-import-modulo = systemDaemonFromAgent
    "dev.media-feed-import-modulo"
    config.home-manager.users.bdsqqq.launchd.agents.media-feed-import-modulo.config;
  launchd.daemons.media-feed-poller = systemDaemonFromAgent
    "dev.media-feed-poller"
    config.home-manager.users.bdsqqq.launchd.agents.media-feed-poller.config;
  launchd.daemons.photo-intelligence = systemDaemonFromAgent
    "dev.photo-intelligence"
    config.home-manager.users.bdsqqq.launchd.agents.photo-intelligence.config;
  launchd.daemons.ssd-gallery = systemDaemonFromAgent
    "dev.ssd-gallery"
    config.home-manager.users.bdsqqq.launchd.agents.ssd-gallery.config;
  launchd.daemons.syncthing = systemDaemonFromAgent
    "dev.syncthing"
    config.home-manager.users.bdsqqq.launchd.agents.syncthing.config;
  launchd.daemons.syncthing-init = systemDaemonFromAgent
    "dev.syncthing.init"
    config.home-manager.users.bdsqqq.launchd.agents.syncthing-init.config;
  launchd.daemons.transmission = systemDaemonFromAgent
    "dev.transmission"
    config.home-manager.users.bdsqqq.launchd.agents.transmission-daemon.config;

  system.activationScripts.preActivation.text = lib.mkAfter ''
    rm -f \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.backup-health.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.files-browser.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.html-stuff.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.ipad-display.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.media-feed-import-modulo.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.media-feed-poller.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.photo-intelligence.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.ssd-gallery.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.syncthing.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.syncthing-init.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.transmission-daemon.plist"}
  '';

  homebrew = {
    enable = true;
    casks = [
      "cleanshot"
      "obsidian"
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
