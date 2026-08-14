{ config, pkgs, lib, inputs, ... }:

let
  mbpPubKey =
    lib.removeSuffix "\n" (builtins.readFile ../../system/ssh-keys/mbp-m2.pub);
  homeManagerBackupCommand = pkgs.writeShellScript "home-manager-unique-backup" ''
    set -eu

    target="$1"
    ext="''${HOME_MANAGER_BACKUP_EXT:-backup}"
    candidate="$target.$ext"

    if [ -e "$candidate" ]; then
      stamp="$(${pkgs.coreutils}/bin/date +%Y%m%d%H%M%S)"
      candidate="$target.$ext.$stamp"
      i=1
      while [ -e "$candidate" ]; do
        candidate="$target.$ext.$stamp.$i"
        i=$((i + 1))
      done
    fi

    ${pkgs.coreutils}/bin/mv "$target" "$candidate"
  '';
in
{
  imports = [
    ../../modules/primary-user.nix
    ../../system/nix.nix
    ../../system/nh.nix
    ../../system/nix-ld.nix
    ../../system/ssh.nix
    ../../system/tailscale.nix
    ../../system/tailnet-registry.nix
    ../../system/sops.nix
    ../../system/authorized-keys.nix
    ../../system/fonts.nix
    ../../system/auto-upgrade.nix
    ../../system/o11y
    ../../system/o11y/hwmon.nix
    ../../user/shell-baseline.nix
    ../../user/node-pnpm
    ../../user/fnm.nix
    ../../user/syncthing-automerge
    ./hardware-configuration.nix
  ];

  my.primaryUser = "bdsqqq";
  services.hwmon-metrics.enable = true;

  boot.kernelPackages = pkgs.unstable.linuxPackages_latest;

  nix.gc = {
    dates = "daily";
    options = "--delete-older-than 3d";
  };

  boot.kernelParams = [
    "console=ttyS0,19200n8"
    "console=tty0"
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
      allowedTCPPorts = [ ];
      allowedUDPPorts = [ ];
      interfaces.tailscale0.allowedTCPPorts = [ 22 ];
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
    openssh.authorizedKeys.keys = [ mbpPubKey ];
    hashedPassword =
      "$6$LeozgmV9I6N0QYNf$3BeytD3X/gFNzBJAeWYqFPqD7m9Qz4gn8vORyFtrJopplmZ/pgLZzcktymHLU9CVbR.SkFPg9MAbYNKWLzvaT0";
  };

  services.openssh.settings = {
    PasswordAuthentication = false;
    PermitRootLogin = "no";
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.zsh.enable = true;

  # The small root disk carries only a Git checkout; unlike htz-relay, this
  # host intentionally has no Syncthing dataset or storage-backed services.
  systemd.services.syncthing-automerge.enable = false;

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";
    backupCommand = homeManagerBackupCommand;
    extraSpecialArgs = {
      inherit inputs;
      isDarwin = false;
      hostSystem = "x86_64-linux";
      headMode = "headless";
      torchBackend = "cpu";
    };
    users.bdsqqq = { lib, ... }: {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
      home.activation.installPnpmTools =
        lib.mkForce (lib.hm.dag.entryAfter [ "linkGeneration" ] "");
      home.activation.installVitePlus =
        lib.mkForce (lib.hm.dag.entryAfter [ "linkGeneration" ] "");
      programs.ssh.settings."github.com" = {
        HostName = "github.com";
        User = "git";
        IdentityFile = "~/.ssh/github-dots-deploy";
        IdentitiesOnly = true;
      };
    };
  };

  time.timeZone = "America/Sao_Paulo";
  i18n.defaultLocale = "en_US.UTF-8";

  environment.shellAliases.g = "lazygit";
  environment.systemPackages = with pkgs; [
    curl
    ethtool
    git
    ghostty.terminfo
    htop
    jq
    lazygit
    ripgrep
    tree
    zmx
  ];

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "25.05";
}
