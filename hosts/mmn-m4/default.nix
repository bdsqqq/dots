{
  config,
  inputs,
  pkgs,
  lib,
  ...
}:
let
  syncthing = import ../../modules/syncthing.nix { inherit lib; };
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
    ../../system/nix.nix
    ../../system/nh.nix
    ../../system/sops.nix
    ../../system/homebrew-best-effort.nix
    ../../system/tailscale.nix
    ../../system/tailnet-registry.nix
    ../../system/syncthing.nix
    ../../system/o11y
    ../mbp-m2/moshi-host.nix
    ../../system/sleepless.nix
    ../../system/cmux.nix
    ../../system/fonts.nix
    ../../user/shell-baseline.nix
    ../../user/node-pnpm
    ../../user/1password.nix
    ../../user/orbstack.nix
    ../../user/ghostty.nix
    ../../user/ipad-display.nix
    ../../user/html-stuff
    ../../user/media-feeds.nix
    ../../user/storage-preview.nix
  ];

  networking = {
    hostName = "mmn-m4.local";
    localHostName = "mmn-m4";
    computerName = "mmn-m4";
  };

  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";
  my.primaryUser = "bdsqqq";
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
          folders.commonplace = syncthing.folderForPath "commonplace" "/Users/bdsqqq/commonplace" [
            "mbp-m2"
            "htz-relay"
          ] { label = "commonplace"; };
        };
      };

      launchd.agents.syncthing.enable = lib.mkForce false;
      launchd.agents.syncthing-init.enable = lib.mkForce false;
      launchd.agents.files-browser.enable = lib.mkForce false;
    };
  };

  launchd.daemons.files-browser = systemDaemonFromAgent
    "dev.files-browser"
    config.home-manager.users.bdsqqq.launchd.agents.files-browser.config;
  launchd.daemons.syncthing = systemDaemonFromAgent
    "dev.syncthing"
    config.home-manager.users.bdsqqq.launchd.agents.syncthing.config;
  launchd.daemons.syncthing-init = systemDaemonFromAgent
    "dev.syncthing.init"
    config.home-manager.users.bdsqqq.launchd.agents.syncthing-init.config;

  system.activationScripts.preActivation.text = lib.mkAfter ''
    rm -f \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.files-browser.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.syncthing.plist"} \
      ${lib.escapeShellArg "${home}/Library/LaunchAgents/org.nix-community.home.syncthing-init.plist"}
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
