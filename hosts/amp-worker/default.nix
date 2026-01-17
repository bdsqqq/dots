{ config
, pkgs
, lib
, modulesPath
, inputs
, ...
}:

let
  mbpPubKey = lib.removeSuffix "\n" (builtins.readFile ../../system/ssh-keys/mbp-m2.pub);
in {
  imports = (
    [
      ../../bundles/base.nix
      ../../bundles/dev.nix
      ../../system/vector.nix
    ]
  ) ++ lib.optionals (builtins.pathExists ./hardware-configuration.nix) [ ./hardware-configuration.nix ];

  networking.hostName = "amp-worker";
  networking.useDHCP = lib.mkDefault true;
  networking.networkmanager.enable = false;

  networking.firewall = {
    enable = true;
    allowPing = false;
    trustedInterfaces = [ "tailscale0" ];
    allowedTCPPorts = [ 8080 ]; # webhook receiver
    allowedUDPPorts = [ ];
    checkReversePath = "loose";
  };

  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
    extraUpFlags = [ "--ssh" "--accept-dns=false" ];
    authKeyFile = lib.mkIf (config.sops.secrets ? tailscale_auth_key) config.sops.secrets.tailscale_auth_key.path;
  };

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [ mbpPubKey ];
    hashedPassword = "$6$LeozgmV9I6N0QYNf$3BeytD3X/gFNzBJAeWYqFPqD7m9Qz4gn8vORyFtrJopplmZ/pgLZzcktymHLU9CVbR.SkFPg9MAbYNKWLzvaT0";
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.zsh.enable = true;
  programs.tmux.enable = true;

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = { inherit inputs; isDarwin = false; hostSystem = "x86_64-linux"; headMode = "headless"; torchBackend = "cpu"; };
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
    };
  };

  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  boot.loader.grub = {
    enable = true;
    device = "/dev/sda";
  };

  environment.systemPackages = with pkgs; [
    git
    curl
    htop
    jq
  ];

  services.qemuGuest.enable = true;

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "25.05";
}
