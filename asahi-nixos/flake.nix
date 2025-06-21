{
  description = "Asahi Linux NixOS configuration with niri window manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";

    # Apple Silicon support for Asahi Linux
    apple-silicon.url = "github:tpwrules/nixos-apple-silicon";
    apple-silicon.inputs.nixpkgs.follows = "nixpkgs";

    # Home Manager
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    # Niri window manager
    niri.url = "github:sodiboo/niri-flake";
    niri.inputs.nixpkgs.follows = "nixpkgs";

    # Secrets management
    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "aarch64-linux" ];

      perSystem = { config, self', inputs', pkgs, system, ... }: {
        # Development shell
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # System administration tools
            nixos-rebuild
            nixpkgs-fmt
            nil
            statix
            deadnix
            cachix
            direnv
            
            # Asahi-specific tools
            asahi-bless # Asahi bootloader management
            asahi-fwextract # Firmware extraction
            u-boot-asahi # U-Boot bootloader
          ];

          shellHook = ''
            echo "🚀 Asahi NixOS development environment"
            echo "Available tools:"
            echo "  - nixos-rebuild: System configuration management"
            echo "  - asahi-bless: Bootloader management"
            echo "  - asahi-fwextract: Firmware extraction"
            echo "  - u-boot-asahi: U-Boot bootloader"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      };

      flake = {
        nixosConfigurations = {
          asahi = inputs.nixpkgs.lib.nixosSystem {
            system = "aarch64-linux";
            specialArgs = { 
              inherit inputs;
              unstable = import inputs.nixpkgs-unstable {
                system = "aarch64-linux";
                config.allowUnfree = true;
              };
            };
            modules = [
              # Apple Silicon hardware support
              inputs.apple-silicon.nixosModules.apple-silicon-support
              
              # Niri window manager
              inputs.niri.nixosModules.niri
              
              # Home Manager integration
              inputs.home-manager.nixosModules.home-manager
              
              # SOPS secrets management
              inputs.sops-nix.nixosModules.sops
              
              # System configuration
              ./configuration.nix
              ./hardware.nix
              
              # Home Manager configuration
              {
                home-manager = {
                  useGlobalPkgs = true;
                  useUserPackages = true;
                  extraSpecialArgs = { 
                    inherit inputs;
                    unstable = import inputs.nixpkgs-unstable {
                      system = "aarch64-linux";
                      config.allowUnfree = true;
                    };
                  };
                  users.bdsqqq = import ./home.nix;
                };
              }
            ];
          };
        };
      };
    };
}
