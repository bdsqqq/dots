{ config
, pkgs
, lib
, modulesPath
, inputs
, ...
}:

{
  imports = [
    # this will be generated on the hetzner install then copied here
    ./hardware-configuration.nix
    ../../modules/shared/default.nix
  ];

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

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
    extraUpFlags = [ "--ssh" "--accept-dns=false" ];
  };

  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
    openDefaultPorts = false;
    guiAddress = "127.0.0.1:8384";
    settings = {
      options = {
        urAccepted = -1;
        globalAnnounceEnabled = false;
        localAnnounceEnabled = true;
        relaysEnabled = false;
        natEnabled = false;
        upnpEnabled = false;
        listenAddress = "tcp://0.0.0.0:22000,quic://0.0.0.0:22000";
      };
      devices = { };
      folders = { };
    };
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



