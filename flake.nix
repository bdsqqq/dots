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

    textfox.url = "github:adriankarlen/textfox";
    textfox.flake = false;
    
    # Loupe wallpapers
    loupe-dark.url = "path:./modules/shared/loupe-mono-dark.jpg";
    loupe-dark.flake = false;
    
    loupe-light.url = "path:./modules/shared/loupe-mono-light.jpg";
    loupe-light.flake = false;
    
    # Berkeley Mono font family
    berkeley-mono.url = "path:./modules/shared/berkeley-mono";
    berkeley-mono.flake = false;

    # hyprland window manager
    hyprland.url = "github:hyprwm/Hyprland";
    hyprland.inputs.nixpkgs.follows = "nixpkgs";

    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # NixOS hardware modules
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    
    # Declarative Flatpak management
    nix-flatpak.url = "github:gmodena/nix-flatpak";
  };

  outputs = inputs@{ flake-parts, stylix, ... }:
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
              # Stylix theming
              stylix.darwinModules.stylix
              
              # Host-specific configuration
              ./hosts/mbp14.local/default.nix

              # Shared darwin modules (automatically available to all darwin hosts)
              {
                # Ensure all modules receive enhanced specialArgs
                _module.args = { inherit inputs; isDarwin = true; };
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
          "r56" = inputs.nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            specialArgs = { inherit inputs; };
            modules = [
              stylix.nixosModules.stylix
              inputs.hyprland.nixosModules.default
              inputs.home-manager.nixosModules.home-manager
              ./hosts/r56/default.nix
            ];
          };

          "htz-far" = inputs.nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            specialArgs = { inherit inputs; };
            modules = [
              inputs.home-manager.nixosModules.home-manager
              ./hosts/htz-far/default.nix
            ];
          };
        };
      };
    };
}
