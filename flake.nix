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

    # Berkeley Mono font family
    berkeley-mono.url = "path:./modules/shared/berkeley-mono";
    berkeley-mono.flake = false;

    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # NixOS hardware modules
    nixos-hardware.url = "github:NixOS/nixos-hardware/master";
    
    # Declarative Flatpak management
    nix-flatpak.url = "github:gmodena/nix-flatpak";

    # Declarative Spicetify configuration
    spicetify-nix.url = "github:Gerg-L/spicetify-nix";
    spicetify-nix.inputs.nixpkgs.follows = "nixpkgs";

    # File server
    copyparty.url = "github:9001/copyparty";
    copyparty.inputs.nixpkgs.follows = "nixpkgs";

    # Vicinae launcher (no nixpkgs.follows to preserve cachix cache hits)
    vicinae.url = "github:vicinaehq/vicinae";
  };

  outputs = inputs@{ self, flake-parts, stylix, ... }:
    let
      # get git revision for configuration tracking
      flakeRevision = self.rev or self.dirtyRev or "unknown";
    in
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
        # Darwin configurations
        darwinConfigurations = {
          "mbp-m2" = inputs.nix-darwin.lib.darwinSystem {
            system = "aarch64-darwin";
            # Enhanced specialArgs: pass all inputs, system info, and utilities
            specialArgs = {
              inherit inputs;
              hostSystem = "aarch64-darwin";
              headMode = "graphical";
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
              inputs.sops-nix.darwinModules.sops
              # Apply overlays to the main system packages
              {
                nixpkgs = {
                  config.allowUnfree = true;
                  overlays = [ (import ./overlays/unstable.nix inputs) ];
                };
                # track git revision for deploy annotations
                system.configurationRevision = flakeRevision;
              }
              
              # Host-specific configuration
              ./hosts/mbp-m2/default.nix

              # Shared darwin modules (automatically available to all darwin hosts)
              {
                # Ensure all modules receive enhanced specialArgs
                _module.args = { inherit inputs; isDarwin = true; headMode = "graphical"; };
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

        # NixOS configurations
        nixosConfigurations = {
          "r56" = inputs.nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            specialArgs = { inherit inputs; hostSystem = "x86_64-linux"; headMode = "graphical"; };
            modules = [
              inputs.sops-nix.nixosModules.sops
              stylix.nixosModules.stylix
              inputs.home-manager.nixosModules.home-manager
              inputs.nix-flatpak.nixosModules.nix-flatpak
              ({ pkgs, ... }: {
                nixpkgs.overlays = [ (import ./overlays/unstable.nix inputs) ];
                nixpkgs.config.cudaSupport = true;
                system.configurationRevision = flakeRevision;
              })
              ./hosts/r56/default.nix
            ];
          };

          "htz-relay" = inputs.nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            specialArgs = { inherit inputs; hostSystem = "x86_64-linux"; headMode = "headless"; };
            modules = [
              inputs.sops-nix.nixosModules.sops
              stylix.nixosModules.stylix
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.home-manager.nixosModules.home-manager
              inputs.copyparty.nixosModules.default
              ({ pkgs, ... }: {
                nixpkgs.overlays = [ 
                  inputs.copyparty.overlays.default 
                  (import ./overlays/unstable.nix inputs)
                ];
                system.configurationRevision = flakeRevision;
              })
              ./hosts/htz-relay/default.nix
            ];
          };
        };
      };
    };
}
