# NixOS configuration for htz-far (Hetzner VPS)
# Minimal server setup for syncthing + tailscale + dev maintenance
{ config, pkgs, lib, inputs, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    ../../modules/shared/default.nix
  ];

  # Boot configuration
  boot.initrd.availableKernelModules = [ "xhci_pci" "ahci" "nvme" "usbhid" "sd_mod" ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ ];
  boot.extraModulePackages = [ ];

  boot.loader = {
    systemd-boot.enable = true;
    efi.canTouchEfiVariables = true;
  };

  # Basic system settings
  networking.hostName = "htz-far";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;

  time.timeZone = "UTC";
  i18n.defaultLocale = "en_US.UTF-8";
  i18n.inputMethod.enabled = null;

  # Enable Tailscale VPN
  services.tailscale.enable = true;

  # Enable SSH with key-only authentication
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  # Enable Syncthing
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
    openDefaultPorts = true;
    guiAddress = "0.0.0.0:8384";
  };

  # Firewall - allow SSH and Syncthing
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 8384 22000 ];
    allowedUDPPorts = [ 22000 21027 ];
  };

  # Your user
  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" ];
    shell = pkgs.zsh;
  };

  # Enable zsh
  programs.zsh.enable = true;

  # Home-manager setup (minimal for server)
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;

    users.bdsqqq = {
      imports = [
        inputs.nixvim.homeManagerModules.nixvim
        ../../modules/home-manager/default.nix
      ];
    };

    extraSpecialArgs = {
      inherit inputs;
      isDarwin = false;
    };
  };

  # Enable unfree packages
  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  # Automatic garbage collection
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  # System state version
  system.stateVersion = "25.05";
}