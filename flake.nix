{
  description = "Multi-system nix configuration with enhanced foundation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";

    nix-darwin.url = "github:nix-darwin/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";

    berkeley-mono.url = "path:./modules/shared/berkeley-mono";
    berkeley-mono.flake = false;

    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixos-hardware.url = "github:NixOS/nixos-hardware/master";

    nix-flatpak.url = "github:gmodena/nix-flatpak";

    spicetify-nix.url = "github:Gerg-L/spicetify-nix";
    spicetify-nix.inputs.nixpkgs.follows = "nixpkgs";

    # Vicinae launcher (no nixpkgs.follows to preserve cachix cache hits)
    # testing focus-loss fix - revert to vicinaehq/vicinae after PR merged
    vicinae.url = "github:bdsqqq/vicinae/f1afea89";

    axiom-deploy-annotation.url = "github:bdsqqq/axiom-deploy-annotation";
    axiom-deploy-annotation.inputs.nixpkgs.follows = "nixpkgs";

    niri.url = "github:sodiboo/niri-flake";

    quickshell = {
      url = "git+https://git.outfoxxed.me/outfoxxed/quickshell";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Jovian NixOS - Steam Deck experience for handhelds
    jovian-nixos = {
      url = "github:Jovian-Experiments/Jovian-NixOS";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Cursor - auto-updating from apt repo
    cursor = {
      url = "github:bdsqqq/cursor-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    lnr = {
      url = "github:bdsqqq/lnr";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    axiom-skills = {
      url = "github:axiomhq/skills";
      flake = false;
    };

    snarktank-ralph-skills = {
      url = "github:snarktank/ralph";
      flake = false;
    };

    vercel-skills = {
      url = "github:vercel-labs/agent-skills";
      flake = false;
    };

    plugin-vim-tmux-navigator = { url = "github:christoomey/vim-tmux-navigator"; flake = false; };
    plugin-oil-nvim = { url = "github:stevearc/oil.nvim"; flake = false; };
    plugin-nvim-ufo = { url = "github:kevinhwang91/nvim-ufo"; flake = false; };
    plugin-promise-async = { url = "github:kevinhwang91/promise-async"; flake = false; };
    plugin-vim-sleuth = { url = "github:tpope/vim-sleuth"; flake = false; };
    plugin-fidget-nvim = { url = "github:j-hui/fidget.nvim"; flake = false; };
    plugin-autoclose-nvim = { url = "github:m4xshen/autoclose.nvim"; flake = false; };
    plugin-lazydev-nvim = { url = "github:folke/lazydev.nvim"; flake = false; };
    plugin-gitsigns-nvim = { url = "github:lewis6991/gitsigns.nvim"; flake = false; };
    plugin-which-key-nvim = { url = "github:folke/which-key.nvim"; flake = false; };
    plugin-plenary-nvim = { url = "github:nvim-lua/plenary.nvim"; flake = false; };
    plugin-telescope-nvim = { url = "github:nvim-telescope/telescope.nvim"; flake = false; };
    plugin-telescope-fzf-native-nvim = { url = "github:nvim-telescope/telescope-fzf-native.nvim"; flake = false; };
    plugin-telescope-ui-select-nvim = { url = "github:nvim-telescope/telescope-ui-select.nvim"; flake = false; };
    plugin-nvim-lspconfig = { url = "github:neovim/nvim-lspconfig"; flake = false; };
    plugin-conform-nvim = { url = "github:stevearc/conform.nvim"; flake = false; };
    plugin-mini-nvim = { url = "github:echasnovski/mini.nvim"; flake = false; };
    plugin-undotree = { url = "github:mbbill/undotree"; flake = false; };
    plugin-ts-error-translator = { url = "github:dmmulroy/ts-error-translator.nvim"; flake = false; };
    plugin-vim-tpipeline = { url = "github:vimpostor/vim-tpipeline"; flake = false; };
    plugin-amp-nvim = { url = "github:sourcegraph/amp.nvim"; flake = false; };
  };

  outputs = inputs@{ self, flake-parts, stylix, ... }:
    let
      # get git revision for configuration tracking
      flakeRevision = self.rev or self.dirtyRev or "unknown";
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

      perSystem = { config, self', inputs', pkgs, system, ... }: {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nixpkgs-fmt
            nil
            statix
            deadnix

            cachix
            direnv

          ] ++ (if pkgs.stdenv.isDarwin then [
            inputs.nix-darwin.packages.${system}.darwin-rebuild
          ] else [
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

        formatter = pkgs.nixpkgs-fmt;
      };

      flake = {
        darwinConfigurations = {
          "mbp-m2" = inputs.nix-darwin.lib.darwinSystem {
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
              inputs.axiom-deploy-annotation.darwinModules.default
              # Apply overlays to the main system packages
              ({ config, ... }: {
                nixpkgs = {
                  hostPlatform = "aarch64-darwin";
                  config.allowUnfree = true;
                  overlays = [ (import ./overlays/unstable.nix inputs) ];
                };
                # track git revision for deploy annotations
                system.configurationRevision = flakeRevision;
                
                services.axiom-deploy-annotation = {
                  enable = true;
                  configPath = config.sops.secrets."axiom.toml".path;
                  dataset = "papertrail";
                  datasets = [ "papertrail" "host-metrics" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                };
              })
              
              ./hosts/mbp-m2/default.nix

              {
                # Ensure all modules receive enhanced specialArgs
                _module.args = { inherit inputs; isDarwin = true; headMode = "graphical"; };
              }
            ];
          };
        };

        nixosConfigurations = {
          "r56" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = { inherit inputs; hostSystem = "x86_64-linux"; headMode = "graphical"; };
            modules = [
              inputs.sops-nix.nixosModules.sops
              inputs.axiom-deploy-annotation.nixosModules.default
              stylix.nixosModules.stylix
              inputs.home-manager.nixosModules.home-manager
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.niri.nixosModules.niri
              ({ pkgs, config, lib, ... }: {
                nixpkgs.hostPlatform = "x86_64-linux";
                nixpkgs.overlays = [ 
                  (import ./overlays/unstable.nix inputs)
                  (import ./overlays/quickshell.nix inputs)
                ];
                system.configurationRevision = flakeRevision;

                services.axiom-deploy-annotation = {
                  enable = true;
                  configPath = config.sops.secrets."axiom.toml".path;
                  dataset = "papertrail";
                  datasets = [ "papertrail" "host-metrics" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                  user = "bdsqqq";
                  group = "users";
                };
                systemd.services.axiom-deploy-annotation.serviceConfig.ProtectHome = lib.mkForce "read-only";
              })
              ./hosts/r56/default.nix
            ];
          };

          "htz-relay" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = { inherit inputs; hostSystem = "x86_64-linux"; headMode = "headless"; };
            modules = [
              inputs.sops-nix.nixosModules.sops
              inputs.axiom-deploy-annotation.nixosModules.default
              stylix.nixosModules.stylix
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.home-manager.nixosModules.home-manager
              inputs.copyparty.nixosModules.default
              ({ pkgs, config, lib, ... }: {
                nixpkgs.hostPlatform = "x86_64-linux";
                nixpkgs.overlays = [ 
                  inputs.copyparty.overlays.default 
                  (import ./overlays/unstable.nix inputs)
                ];
                system.configurationRevision = flakeRevision;
                
                services.axiom-deploy-annotation = {
                  enable = true;
                  configPath = config.sops.secrets."axiom.toml".path;
                  dataset = "papertrail";
                  datasets = [ "papertrail" "host-metrics" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                  user = "bdsqqq";
                  group = "users";
                };
                systemd.services.axiom-deploy-annotation.serviceConfig.ProtectHome = lib.mkForce "read-only";
              })
              ./hosts/htz-relay/default.nix
            ];
          };

          "lgo-z2e" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = { inherit inputs; hostSystem = "x86_64-linux"; headMode = "graphical"; };
            modules = [
              inputs.sops-nix.nixosModules.sops
              inputs.axiom-deploy-annotation.nixosModules.default
              stylix.nixosModules.stylix
              inputs.home-manager.nixosModules.home-manager
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.niri.nixosModules.niri
              inputs.jovian-nixos.nixosModules.default
              ({ pkgs, config, lib, ... }: {
                nixpkgs.hostPlatform = "x86_64-linux";
                nixpkgs.overlays = [ 
                  (import ./overlays/unstable.nix inputs)
                  (import ./overlays/quickshell.nix inputs)
                ];
                system.configurationRevision = flakeRevision;
                
                services.axiom-deploy-annotation = {
                  enable = true;
                  configPath = config.sops.secrets."axiom.toml".path;
                  dataset = "papertrail";
                  datasets = [ "papertrail" "host-metrics" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                  user = "bdsqqq";
                  group = "users";
                };
                systemd.services.axiom-deploy-annotation.serviceConfig.ProtectHome = lib.mkForce "read-only";
              })
              ./hosts/lgo-z2e/default.nix
            ];
          };

          "lgo-z2e-installer" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = { inherit inputs; };
            modules = [
              { nixpkgs.hostPlatform = "x86_64-linux"; }
              ./iso/lgo-z2e-installer.nix
            ];
          };

        };
      };
    };
}
