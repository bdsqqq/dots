{
  description = "Multi-system nix configuration with enhanced foundation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Separate unstable channel for bleeding-edge packages via overlay
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";

    nix-darwin.url = "github:nix-darwin/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    nixvim.url = "github:nix-community/nixvim";
    nixvim.inputs.nixpkgs.follows = "nixpkgs";

    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";

    # niri window manager
    niri.url = "github:sodiboo/niri-flake";
    niri.inputs.nixpkgs.follows = "nixpkgs";

    # NixOS hardware modules
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      # Multi-system support for cross-platform compatibility
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

      perSystem = { config, self', inputs', pkgs, system, ... }: {
        # Development shell with essential nix tooling
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Nix development tools
            nixpkgs-fmt
            nil
            statix
            deadnix

            # System administration tools
            cachix
            direnv

            # Optional: system-specific tools
          ] ++ (if pkgs.stdenv.isDarwin then [
            # Darwin-specific development tools
            inputs.nix-darwin.packages.${system}.darwin-rebuild
          ] else [
            # NixOS development tools
            nixos-rebuild
            nixos-generators
          ]);

          shellHook = ''
            echo "🚀 nix development environment loaded"
            echo "Available tools:"
            echo "  - nixpkgs-fmt: Format nix code"
            echo "  - nil: Nix language server"
            echo "  - statix: Linter for nix"
            echo "  - deadnix: Find unused code"
            echo "  - cachix: Binary cache management"
            echo "  - direnv: Environment management"
            ${if pkgs.stdenv.isDarwin then ''
              echo "  - darwin-rebuild: System configuration management"
            '' else ''
              echo "  - nixos-rebuild: NixOS system management"
              echo "  - nixos-generators: ISO/VM image generation"
            ''}
          '';
        };

        # Formatter for `nix fmt`
        formatter = pkgs.nixpkgs-fmt;
      };

      flake = {
        # Darwin configurations with enhanced specialArgs
        darwinConfigurations = {
          # Primary development machine
          "mbp14" = inputs.nix-darwin.lib.darwinSystem {
            system = "aarch64-darwin";
            # Enhanced specialArgs: pass all inputs, system info, and utilities
            specialArgs = {
              inherit inputs;
              # Make system architecture available for conditional logic
              inherit (inputs.nixpkgs.lib) systems;
              # Helper function to get packages for different systems
              pkgsFor = system: import inputs.nixpkgs {
                inherit system;
                config.allowUnfree = true;
                overlays = [ (import ./overlays/unstable.nix inputs) ];
              };
            };
            modules = [
              # Apply overlays to the main system packages
              {
                nixpkgs = {
                  config.allowUnfree = true;
                  overlays = [ (import ./overlays/unstable.nix inputs) ];
                };
              }
              # Host-specific configuration
              ./hosts/mbp14.local/default.nix

              # Shared darwin modules (automatically available to all darwin hosts)
              {
                # Ensure all modules receive enhanced specialArgs
                _module.args = { inherit inputs; };
              }
            ];
          };

          # Example: Future intel mac support
          # "imac" = inputs.nix-darwin.lib.darwinSystem {
          #   system = "x86_64-darwin";
          #   specialArgs = { 
          #     inherit inputs;
          #     inherit (inputs.nixpkgs.lib) systems;
          #     pkgsFor = system: import inputs.nixpkgs {
          #       inherit system; 
          #       config.allowUnfree = true;
          #     };
          #   };
          #   modules = [
          #     ./hosts/imac/default.nix
          #     { _module.args = { inherit inputs; }; }
          #   ];
          # };
        };

        # NixOS configurations using the same foundation
        nixosConfigurations = {
          "windows-pc" = inputs.nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            specialArgs = { 
              inherit inputs;
              inherit (inputs.nixpkgs.lib) systems;
              pkgsFor = system: import inputs.nixpkgs {
                inherit system; 
                config.allowUnfree = true;
                overlays = [ 
                  (import ./overlays/unstable.nix inputs)
                  inputs.niri.overlays.niri
                ];
              };
            };
            modules = [
              # Apply overlays to the main system packages
              {
                nixpkgs = {
                  config.allowUnfree = true;
                  overlays = [ 
                    (import ./overlays/unstable.nix inputs)
                    inputs.niri.overlays.niri
                  ];
                };
              }
              
              # Hardware-specific modules
              inputs.nixos-hardware.nixosModules.common-pc-ssd
              inputs.nixos-hardware.nixosModules.common-cpu-amd
              inputs.nixos-hardware.nixosModules.common-gpu-nvidia-nonprime
              
              # niri module
              inputs.niri.nixosModules.niri
              
              # Host-specific configuration
              ./hosts/windows-pc/default.nix
              
              # Home Manager integration
              inputs.home-manager.nixosModules.home-manager
              
              # Shared modules with enhanced specialArgs
              {
                _module.args = { inherit inputs; };
              }
            ];
          };

          # ISO image for installation
          "windows-pc-iso" = inputs.nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            specialArgs = { 
              inherit inputs;
              inherit (inputs.nixpkgs.lib) systems;
              pkgsFor = system: import inputs.nixpkgs {
                inherit system; 
                config.allowUnfree = true;
                overlays = [ 
                  (import ./overlays/unstable.nix inputs)
                  inputs.niri.overlays.niri
                ];
              };
            };
            modules = [
              # Apply overlays
              {
                nixpkgs = {
                  config.allowUnfree = true;
                  overlays = [ 
                    (import ./overlays/unstable.nix inputs)
                    inputs.niri.overlays.niri
                  ];
                };
              }
              
              # niri module
              inputs.niri.nixosModules.niri
              
              # ISO configuration
              ./hosts/windows-pc/iso.nix
              
              # Shared modules with enhanced specialArgs
              {
                _module.args = { inherit inputs; };
              }
            ];
          };
        };
      };
    };
}
