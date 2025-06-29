# Ultra-minimal NixOS configuration - just niri, no extras
{ pkgs, inputs, lib, config, ... }:

{
  imports = [
    # Hardware
    ../../hardware/windows-pc.nix
    
    # Minimal boot and graphics
    ../../modules/nixos/boot-minimal.nix
    ../../modules/nixos/graphics-minimal.nix
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
    shell = pkgs.bash;  # Use bash for now
  };

  # Minimal home-manager setup
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    
    users.bdsqqq = {
      home = {
        username = "bdsqqq";
        homeDirectory = "/home/bdsqqq";
        stateVersion = "25.05";
        
        # Just the niri config
        file.".config/niri/config.kdl".text = ''
          input {
              keyboard {
                  xkb {
                      layout "us"
                  }
              }
          }
          
          layout {
              gaps 16
              
              border {
                  width 2
              }
          }
          
          binds {
              Mod+Return { spawn "foot"; }
              Mod+D { spawn "fuzzel"; }
              Mod+Q { close-window; }
              
              Mod+H { focus-column-left; }
              Mod+L { focus-column-right; }
              Mod+J { focus-window-down; }
              Mod+K { focus-window-up; }
              
              Mod+1 { focus-workspace 1; }
              Mod+2 { focus-workspace 2; }
              Mod+3 { focus-workspace 3; }
              Mod+4 { focus-workspace 4; }
              Mod+5 { focus-workspace 5; }
          }
          
          spawn-at-startup "waybar"
          spawn-at-startup "mako"
        '';
        
        packages = with pkgs; [
          foot
          fuzzel
          waybar
          mako
        ];
      };
    };
    
    extraSpecialArgs = { inherit inputs; };
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