{ inputs, pkgs, ... }:
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
    ../../system/o11y
    ../mbp-m2/moshi-host.nix
    ../../system/sleepless.nix
    ../../system/cmux.nix
    ../../system/fonts.nix
    ../../user/path-order.nix
    ../../user/shell.nix
    ../../user/ssh.nix
    ../../user/homebrew.nix
    ../../user/node-pnpm
    ../../user/1password.nix
    ../../user/orbstack.nix
    ../../user/ghostty.nix
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
    };
  };

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

  my.tailnetRegistry.directory.enable = true;
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
