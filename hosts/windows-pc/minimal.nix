# Minimal NixOS configuration focused on getting niri working
{ pkgs, inputs, lib, config, ... }:

{
  imports = [
    # Hardware
    ../../hardware/windows-pc.nix
    
    # Minimal boot and graphics
    ../../modules/nixos/boot-minimal.nix
    ../../modules/nixos/graphics-minimal.nix
    
    # Shared tools from your macOS setup
    ../../modules/shared/default.nix
  ];

  # Basic system settings
  networking.hostName = "windows-pc";
  networking.networkmanager.enable = true;
  
  time.timeZone = "America/New_York";
  i18n.defaultLocale = "en_US.UTF-8";

  # Enable niri
  programs.niri.enable = true;

  # Simple display manager
  services.greetd = {
    enable = true;
    settings.default_session = {
      command = "${pkgs.greetd.tuigreet}/bin/tuigreet --cmd niri-session";
      user = "greeter";
    };
  };

  # Audio
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    pulse.enable = true;
  };

  # Your user
  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" ];
    shell = pkgs.zsh;
  };

  programs.zsh.enable = true;

  # Home Manager
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    
    users.bdsqqq = {
      imports = [
        inputs.nixvim.homeManagerModules.nixvim
        ../../modules/home-manager/default.nix
        ../../modules/home-manager/profiles/niri.nix
      ];
      
      home.stateVersion = "25.05";
    };
    
    extraSpecialArgs = {
      inherit inputs;
      isNixOS = true;
      isDarwin = false;
    };
  };

  # Essential packages only
  environment.systemPackages = with pkgs; [
    vim
    git
    curl
    wget
  ];

  # Enable flakes
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  
  nixpkgs.config.allowUnfree = true;
  system.stateVersion = "25.05";
}