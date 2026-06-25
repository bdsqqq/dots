{ config, pkgs, lib, inputs, ... }:

{
  imports = [
    ../../modules/primary-user.nix
    ../../system/nix.nix
    ../../system/nh.nix
    ../../system/nix-ld.nix
    ../../system/ssh.nix
    ../../system/tailscale.nix
    ../../system/authorized-keys.nix
    ./hardware-configuration.nix
  ];

  networking = {
    hostName = "gru-relay";
    useDHCP = false;
    usePredictableInterfaceNames = false;
    networkmanager.enable = false;
    nameservers = [
      "172.233.0.9"
      "172.233.0.7"
      "172.233.0.4"
      "1.1.1.1"
    ];
    defaultGateway = {
      address = "172.237.60.1";
      interface = "eth0";
    };
    defaultGateway6 = {
      address = "fe80::a9fe:a9fe";
      interface = "eth0";
    };
    interfaces.eth0 = {
      ipv4.addresses = [{
        address = "172.237.60.82";
        prefixLength = 24;
      }];
      ipv6.addresses = [{
        address = "2600:3c0d::2000:84ff:fefb:6385";
        prefixLength = 64;
      }];
    };
    firewall = {
      enable = true;
      allowPing = false;
      trustedInterfaces = [ "tailscale0" ];
      allowedTCPPorts = [ 22 ];
      allowedUDPPorts = [ ];
      checkReversePath = "loose";
    };
  };

  my.primaryUser = "bdsqqq";

  services.tailscale = {
    enable = true;
    openFirewall = false;
    useRoutingFeatures = "server";
    extraSetFlags = [
      "--hostname=gru-relay"
      "--ssh"
      "--advertise-exit-node"
      "--accept-dns=false"
      "--shields-up=false"
    ];
  };

  systemd.services.tailscale-udp-gro-forwarding = {
    description = "Enable UDP GRO forwarding for Tailscale exit-node throughput";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    path = [ pkgs.ethtool ];
    serviceConfig.Type = "oneshot";
    script = ''
      ethtool -K eth0 rx-udp-gro-forwarding on rx-gro-list off || true
    '';
  };

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.zsh;
    hashedPassword =
      "$6$LeozgmV9I6N0QYNf$3BeytD3X/gFNzBJAeWYqFPqD7m9Qz4gn8vORyFtrJopplmZ/pgLZzcktymHLU9CVbR.SkFPg9MAbYNKWLzvaT0";
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.zsh.enable = true;

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";
    extraSpecialArgs = {
      inherit inputs;
      isDarwin = false;
      hostSystem = "x86_64-linux";
      headMode = "headless";
      torchBackend = "cpu";
    };
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
      programs.zsh.enable = true;
    };
  };

  time.timeZone = "America/Sao_Paulo";
  i18n.defaultLocale = "en_US.UTF-8";

  environment.systemPackages = with pkgs; [
    curl
    ethtool
    git
    htop
    jq
    ripgrep
    tree
  ];

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "25.05";
}
