{ config, pkgs, lib, ... }:

{
  imports = [
    ../../system/ssh.nix
    ../../system/tailscale.nix
    ../../system/authorized-keys.nix
    ./hardware-configuration.nix
  ];

  boot.kernelParams = [
    "console=ttyS0,19200n8"
    "console=tty0"
  ];

  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
      substituters = [
        "https://cache.nixos.org/"
        "https://nix-community.cachix.org"
      ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
    optimise.automatic = true;
    gc = {
      automatic = true;
      options = "--delete-older-than 14d";
    };
  };

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
      "--netfilter-mode=nodivert"
    ];
  };

  # Keep public ingress owned by the NixOS firewall while still letting
  # Tailscale's exit-node forwarding and masquerade chains do their job.
  systemd.services.tailscaled.postStart = ''
    for _ in $(${pkgs.coreutils}/bin/seq 1 20); do
      if ${pkgs.iptables}/bin/iptables -S ts-forward >/dev/null 2>&1 \
        && ${pkgs.iptables}/bin/iptables -t nat -S ts-postrouting >/dev/null 2>&1 \
        && ${pkgs.iptables}/bin/ip6tables -S ts-forward >/dev/null 2>&1 \
        && ${pkgs.iptables}/bin/ip6tables -t nat -S ts-postrouting >/dev/null 2>&1; then
        break
      fi
      ${pkgs.coreutils}/bin/sleep 1
    done

    ${pkgs.iptables}/bin/iptables -S ts-forward >/dev/null
    ${pkgs.iptables}/bin/iptables -t nat -S ts-postrouting >/dev/null
    ${pkgs.iptables}/bin/ip6tables -S ts-forward >/dev/null
    ${pkgs.iptables}/bin/ip6tables -t nat -S ts-postrouting >/dev/null

    ${pkgs.iptables}/bin/iptables -C FORWARD -j ts-forward 2>/dev/null \
      || ${pkgs.iptables}/bin/iptables -A FORWARD -j ts-forward
    ${pkgs.iptables}/bin/iptables -t nat -C POSTROUTING -j ts-postrouting 2>/dev/null \
      || ${pkgs.iptables}/bin/iptables -t nat -A POSTROUTING -j ts-postrouting
    ${pkgs.iptables}/bin/ip6tables -C FORWARD -j ts-forward 2>/dev/null \
      || ${pkgs.iptables}/bin/ip6tables -A FORWARD -j ts-forward
    ${pkgs.iptables}/bin/ip6tables -t nat -C POSTROUTING -j ts-postrouting 2>/dev/null \
      || ${pkgs.iptables}/bin/ip6tables -t nat -A POSTROUTING -j ts-postrouting
  '';

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

  users.users.root.openssh.authorizedKeys.keys =
    config.users.users.bdsqqq.openssh.authorizedKeys.keys;

  services.openssh.settings.PermitRootLogin = lib.mkForce "prohibit-password";

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.zsh.enable = true;

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
