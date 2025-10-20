{ config
, pkgs
, lib
, modulesPath
, inputs
, ...
}:

{
  imports = (
    [
      ../../bundles/base.nix
      ../../bundles/headless.nix
    ]
  ) ++ lib.optionals (builtins.pathExists ./hardware-configuration.nix) [ ./hardware-configuration.nix ];

  networking.hostName = "htz-relay";
  networking.useDHCP = lib.mkDefault true;
  networking.networkmanager.enable = false;

  networking.firewall = {
    enable = true;
    allowPing = false;
    trustedInterfaces = [ "tailscale0" ];
    allowedTCPPorts = [ ];
    allowedUDPPorts = [ ];
    interfaces.tailscale0.allowedTCPPorts = [ 22000 8384 ];
    interfaces.tailscale0.allowedUDPPorts = [ 22000 ];
    checkReversePath = "loose";
  };

  # ssh provided by base bundle

  # tailscale provided by base bundle; host-specific flags preserved
  services.tailscale.useRoutingFeatures = "client";
  services.tailscale.extraUpFlags = [ "--ssh" "--accept-dns=false" ];

  # syncthing provided by headless bundle; keep host-specific ports
  services.syncthing = {
    openDefaultPorts = false;
    guiAddress = "127.0.0.1:8384";
    settings.options.listenAddress = "tcp://0.0.0.0:22000,quic://0.0.0.0:22000";
  };

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [
      (builtins.readFile ../../config/ssh-keys/mbp14.pub)
    ];
  };

  programs.zsh.enable = true;

  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  boot.loader.grub = {
    enable = true;
    efiSupport = true;
    device = "/dev/sda";
  };

  environment.systemPackages = with pkgs; [
    git
    curl
    htop
    tree
  ];

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "25.05";
}



