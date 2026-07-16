{ config, pkgs, lib, modulesPath, inputs, ... }:

let
  mbpPubKey =
    lib.removeSuffix "\n" (builtins.readFile ../../system/ssh-keys/mbp-m2.pub);
  syncthing = import ../../modules/syncthing.nix { inherit lib; };
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
  imports = ([
    ../../bundles/base.nix
    ../../bundles/headless.nix
    ../../bundles/dev.nix
    ../../system/o11y
    ../../system/o11y/hwmon.nix
    ../../system/t3-code-server.nix
  ]) ++ lib.optionals (builtins.pathExists ./hardware-configuration.nix)
    [ ./hardware-configuration.nix ];

  networking.hostName = "htz-relay";
  networking.useDHCP = lib.mkDefault true;
  networking.networkmanager.enable = false;

  my.primaryUser = "bdsqqq";
  services.hwmon-metrics.enable = true;

  networking.firewall = {
    enable = true;
    allowPing = false;
    trustedInterfaces = [ "tailscale0" ];
    allowedTCPPorts = [ ];
    allowedUDPPorts = [ ];
    interfaces.tailscale0.allowedTCPPorts = [ 22 22000 8384 3923 ];
    interfaces.tailscale0.allowedUDPPorts = [ 22000 ];
    checkReversePath = "loose";
  };

  # ssh provided by base bundle
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  # tailscale provided by base bundle; host-specific flags preserved
  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
    extraSetFlags = [ "--operator=bdsqqq" ];
    extraUpFlags = [ "--ssh" "--accept-dns=false" "--shields-up=false" ];
    authKeyFile = lib.mkIf (config.sops.secrets ? tailscale_auth_key)
      config.sops.secrets.tailscale_auth_key.path;
  };

  # copyparty file server
  services.copyparty = {
    enable = true;
    user = "bdsqqq";
    group = "users";
    settings = {
      i = "0.0.0.0";
      p = [ 3923 ];
      v = [
        "/mnt/storage-01/commonplace:/commonplace:r"
      ]; # read-only for everyone (on tailscale)
      q = true; # quiet mode
    };
  };

  systemd.services.copyparty.serviceConfig.BindPaths =
    [ "/mnt/storage-01/commonplace" ];

  # syncthing provided by headless bundle; declarative mesh settings live here
  services.syncthing = {
    openDefaultPorts = false;
    guiAddress = "0.0.0.0:8384";
    settings = {
      gui = {
        user = "bdsqqq";
        password =
          "$2a$10$jGT.D5kEaNOxsNaCvrmfqukdEW5e9ugrXU/dR15oSAACbDEYIR5YO";
      };
      options = {
        urAccepted = -1;
        listenAddress = [ "tcp://0.0.0.0:22000" "quic://0.0.0.0:22000" ];
        globalAnnounceEnabled = false;
        localAnnounceEnabled = false;
        relaysEnabled = false;
        natEnabled = false;
        maxSendKbps = 0;
        maxRecvKbps = 0;
        connectionLimitEnough = 0;
        connectionLimitMax = 0;
      };

      devices = syncthing.devicesFor [ "mbp-m2" "ipd" "iph16" "lgo-z2e" ];

      folders = {
        commonplace =
          syncthing.folderForPath "commonplace" "/mnt/storage-01/commonplace"
            [ "mbp-m2" "ipd" "iph16" ]
            { rescanIntervalS = 3600; };
        helium-remotes =
          syncthing.folderForPath "helium-remotes" "/mnt/storage-01/helium-remotes"
            [ "mbp-m2" "lgo-z2e" ]
            {
              rescanIntervalS = 60;
            };
      };
    };
  };

  systemd.tmpfiles.rules = [
    "d /mnt/storage-01/commonplace 0700 bdsqqq users -"
    "d /mnt/storage-01/helium-remotes 0700 bdsqqq users -"
  ];

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [ mbpPubKey ];
    hashedPassword =
      "$6$LeozgmV9I6N0QYNf$3BeytD3X/gFNzBJAeWYqFPqD7m9Qz4gn8vORyFtrJopplmZ/pgLZzcktymHLU9CVbR.SkFPg9MAbYNKWLzvaT0";
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.zsh.enable = true;

  # home-manager configuration
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

  environment.systemPackages = with pkgs; [ git curl htop tree ];

  services.qemuGuest.enable = true;

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "25.05";
}
