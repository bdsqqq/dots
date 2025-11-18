{ pkgs, inputs, lib, config, modulesPath, ... }:

let
  mbpPubKey = lib.removeSuffix "\n" (builtins.readFile ../../config/ssh-keys/mbp-m2.pub);
in
{
  imports = [
    ./hardware.nix
    ../../bundles/base.nix
    ../../bundles/headless.nix
    ../../bundles/dev.nix
    ../../system/nvidia.nix
    ../../system/bluetooth.nix
  ];

  networking.hostName = "r56";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  # tailscale and ssh provided by base bundle
  # syncthing provided by headless bundle

  # Your user
  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "audio" "video" "input" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [ mbpPubKey ];
  };

  # Enable zsh
  programs.zsh.enable = true;

  # home-manager module is enabled at flake level; user-layer is provided via bundles
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = { inherit inputs; isDarwin = false; hostSystem = "x86_64-linux"; headMode = "headless"; };
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
    };
  };

  environment.systemPackages = with pkgs; [
    # Basic system tools
    tree
    unzip
    usbutils
  ];

  # fonts provided by base bundle

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
