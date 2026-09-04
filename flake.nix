{
  description = "Multi-system nix configuration with enhanced foundation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";

    nix-darwin.url = "github:nix-darwin/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    berkeley-mono.url = "path:./modules/fonts/berkeley-mono";
    berkeley-mono.flake = false;

    stylix = {
      url = "github:danth/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixos-hardware.url = "github:NixOS/nixos-hardware/master";

    nix-flatpak.url = "github:gmodena/nix-flatpak";

    # Vicinae launcher (no nixpkgs.follows to preserve cachix cache hits)
    vicinae.url = "github:vicinaehq/vicinae/main";

    axiom-deploy-annotation.url = "github:bdsqqq/axiom-deploy-annotation";
    axiom-deploy-annotation.inputs.nixpkgs.follows = "nixpkgs";

    niri.url = "github:sodiboo/niri-flake";
    niri.inputs.niri-unstable.url = "github:niri-wm/niri/v26.04";

    quickshell = {
      url = "git+https://git.outfoxxed.me/outfoxxed/quickshell";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Jovian NixOS - Steam Deck experience for handhelds
    jovian-nixos = {
      url = "github:Jovian-Experiments/Jovian-NixOS";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    copyparty = {
      url = "github:9001/copyparty";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    lnr = {
      url = "github:bdsqqq/lnr";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    axiom-skills = {
      url = "github:axiomhq/skills";
      flake = false;
    };

    vercel-skills = {
      url = "github:vercel-labs/agent-skills";
      flake = false;
    };

    agent-browser = {
      url = "github:vercel-labs/agent-browser";
      flake = false;
    };

    esp-dev.url = "github:mirrexagon/nixpkgs-esp-dev/5287d6e1ca9e15ebd5113c41b9590c468e1e001b";
    qemu-espressif.url = "github:SFrijters/nix-qemu-espressif/5bc8896e7604682383a876e62c6501929775589c";

  };

  outputs = inputs@{ self, flake-parts, stylix, ... }:
    let
      # get git revision for configuration tracking
      flakeRevision = self.rev or self.dirtyRev or "unknown";
      tailnetApps = import ./modules/tailnet/catalog.nix {
        inherit (inputs.nixpkgs) lib;
        root = ./.;
      };
      nixosObservabilityModules = [
        inputs.sops-nix.nixosModules.sops
        inputs.axiom-deploy-annotation.nixosModules.default
        ./modules/o11y
      ];
      mkDarwinSystem = { deployAnnotations ? true }: hostModule: inputs.nix-darwin.lib.darwinSystem {
        specialArgs = {
          inherit inputs tailnetApps;
          hostSystem = "aarch64-darwin";
          headMode = "graphical";
          inherit (inputs.nixpkgs.lib) systems;
          pkgsFor = system:
            import inputs.nixpkgs {
              inherit system;
              config.allowUnfree = true;
              overlays = [
                (import ./overlays/unstable.nix inputs)
                (import ./modules/zmx).overlay
                (import ./overlays/axiom-cli.nix)
                (import ./overlays/libplist-darwin.nix)
              ];
            };
        };
        modules = [
          inputs.sops-nix.darwinModules.sops
          inputs.axiom-deploy-annotation.darwinModules.default
          ./modules/o11y
          ({ config, lib, ... }: {
            nixpkgs = {
              hostPlatform = "aarch64-darwin";
              config.allowUnfree = true;
              overlays = [
                (import ./overlays/unstable.nix inputs)
                (import ./modules/zmx).overlay
                (import ./overlays/axiom-cli.nix)
                (import ./overlays/libplist-darwin.nix)
              ];
            };
            system.configurationRevision = flakeRevision;

            services.axiom-deploy-annotation = lib.mkIf deployAnnotations {
              enable = true;
              tokenPath = config.sops.secrets."axiom/personal_token".path;
              apiEndpoint = "https://api.axiom.co/v2/annotations";
              datasets = [ "papertrail" "papertrail-traces" ];
              repositoryUrl = "https://github.com/bdsqqq/dots";
            };
          })
          hostModule
          {
            _module.args = {
              inherit inputs;
              isDarwin = true;
              headMode = "graphical";
            };
          }
        ];
      };
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems =
        [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];

      perSystem = { config, self', inputs', pkgs, system, ... }: {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs;
            [
              nixpkgs-fmt
              nil
              statix
              deadnix

              cachix
              direnv

            ] ++ (if pkgs.stdenv.isDarwin then
              [ inputs.nix-darwin.packages.${system}.darwin-rebuild ]
            else [
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

        packages.tailnet-artifact-generator = pkgs.writeShellApplication {
          name = "generate-tailnet-artifacts";
          runtimeInputs = [ (pkgs.python3.withPackages (python: [ python.hjson ])) ];
          text = ''
            exec python ${./scripts/generate-tailnet-artifacts.py} \
              --catalog ${pkgs.writeText "fleet-apps.json" (builtins.toJSON tailnetApps.catalog)} \
              --cloudflare ${pkgs.writeText "cloudflare-apps.json" (builtins.toJSON tailnetApps.cloudflareApps)} \
              --services ${pkgs.writeText "tailscale-services.json" (builtins.toJSON tailnetApps.tailscaleServices)} \
              --capabilities ${pkgs.writeText "tailscale-capabilities.json" (builtins.toJSON {
                apps = tailnetApps.capabilities;
                inherit (tailnetApps) connectorTags;
              })} \
              "$@"
          '';
        };

        apps.generate-tailnet-artifacts.program =
          "${config.packages.tailnet-artifact-generator}/bin/generate-tailnet-artifacts";

        packages.photo-semantic-benchmark =
          import ./modules/photo-intelligence/benchmark { inherit pkgs; };

        apps.photo-semantic-benchmark.program =
          "${config.packages.photo-semantic-benchmark}/bin/photo-semantic-benchmark";

        packages.household-intake-smb-audit =
          import ./modules/household-intake/package.nix { inherit pkgs; };

        apps.household-intake-smb-audit.program =
          "${config.packages.household-intake-smb-audit}/bin/household-intake-smb-audit";

        packages.kindle-tailscale-autostart =
          import ./modules/kindle-tailscale-autostart { inherit pkgs; };

        checks.household-intake-smb-audit = pkgs.runCommand "household-intake-smb-audit-tests" { } ''
          ${pkgs.nodejs}/bin/node --test ${./modules/household-intake}/smb-audit.test.mjs
          touch "$out"
        '';

        checks.darwin-transcription = pkgs.runCommand "darwin-transcription-tests"
          {
            nativeBuildInputs = [ pkgs.python3 ];
          } ''
          cp ${./modules/darwin-transcription/darwin_transcription.py} darwin_transcription.py
          cp ${./modules/darwin-transcription/test_darwin_transcription.py} test_darwin_transcription.py
          python -m unittest -v test_darwin_transcription.py
          touch "$out"
        '';

        checks.tailnet-artifacts = pkgs.runCommand "tailnet-artifacts-check" { } ''
          ${config.packages.tailnet-artifact-generator}/bin/generate-tailnet-artifacts \
            --check \
            --root ${self}
          touch "$out"
        '';

        checks.tailnet-registry = pkgs.runCommand "tailnet-registry-tests"
          {
            nativeBuildInputs = [ pkgs.bun ];
          } ''
          mkdir source
          cp ${./modules/tailnet-registry/tailnet-registry.ts} source/tailnet-registry.ts
          cp ${./modules/tailnet-registry/tailnet-registry.test.ts} source/tailnet-registry.test.ts
          cd source
          bun test tailnet-registry.test.ts
          touch "$out"
        '';
      };

      flake = {
        darwinConfigurations = {
          "mbp-m2" = mkDarwinSystem { } ./hosts/mbp-m2/default.nix;
          "mbp-m5" = mkDarwinSystem { deployAnnotations = false; } ./hosts/mbp-m5/default.nix;
          "mmn-m4" = mkDarwinSystem { } ./hosts/mmn-m4/default.nix;
        };

        nixosConfigurations = {
          "htz-xfs-lab" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = {
              inherit inputs tailnetApps;
              hostSystem = "x86_64-linux";
              headMode = "headless";
            };
            modules = [
              inputs.disko.nixosModules.disko
              inputs.home-manager.nixosModules.home-manager
              {
                nixpkgs = {
                  config.allowUnfree = true;
                  overlays = [
                    (import ./overlays/unstable.nix inputs)
                    (import ./modules/zmx).overlay
                  ];
                };
              }
              ./hosts/htz-xfs-lab/default.nix
            ];
          };

          "htz-relay" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = {
              inherit inputs tailnetApps;
              hostSystem = "x86_64-linux";
              headMode = "headless";
            };
            modules = nixosObservabilityModules ++ [
              stylix.nixosModules.stylix
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.home-manager.nixosModules.home-manager
              inputs.copyparty.nixosModules.default
              ({ pkgs, config, lib, ... }: {
                nixpkgs.hostPlatform = "x86_64-linux";
                nixpkgs.overlays = [
                  inputs.copyparty.overlays.default
                  (import ./overlays/unstable.nix inputs)
                  (import ./modules/zmx).overlay
                ];
                system.configurationRevision = flakeRevision;

                services.axiom-deploy-annotation = {
                  enable = true;
                  tokenPath = config.sops.secrets."axiom/personal_token".path;
                  apiEndpoint = "https://api.axiom.co/v2/annotations";
                  datasets = [ "papertrail" "papertrail-traces" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                  user = "bdsqqq";
                  group = "users";
                };
                systemd.services.axiom-deploy-annotation.serviceConfig.ProtectHome =
                  lib.mkForce "read-only";
              })
              ./hosts/htz-relay/default.nix
            ];
          };

          "gru-relay" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = {
              inherit inputs tailnetApps;
              hostSystem = "x86_64-linux";
              headMode = "headless";
            };
            modules = nixosObservabilityModules ++ [
              stylix.nixosModules.stylix
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.home-manager.nixosModules.home-manager
              ({ pkgs, config, lib, ... }: {
                nixpkgs.hostPlatform = "x86_64-linux";
                nixpkgs.overlays = [
                  (import ./overlays/unstable.nix inputs)
                  (import ./modules/zmx).overlay
                ];
                system.configurationRevision = flakeRevision;

                services.axiom-deploy-annotation = {
                  enable = true;
                  tokenPath = config.sops.secrets."axiom/personal_token".path;
                  apiEndpoint = "https://api.axiom.co/v2/annotations";
                  datasets = [ "papertrail" "papertrail-traces" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                  user = "bdsqqq";
                  group = "users";
                };
                systemd.services.axiom-deploy-annotation.serviceConfig.ProtectHome =
                  lib.mkForce "read-only";
              })
              ./hosts/gru-relay/default.nix
            ];
          };

          "lgo-z2e" = inputs.nixpkgs.lib.nixosSystem {
            specialArgs = {
              inherit inputs tailnetApps;
              hostSystem = "x86_64-linux";
              headMode = "graphical";
            };
            modules = nixosObservabilityModules ++ [
              stylix.nixosModules.stylix
              inputs.home-manager.nixosModules.home-manager
              inputs.nix-flatpak.nixosModules.nix-flatpak
              inputs.niri.nixosModules.niri
              inputs.jovian-nixos.nixosModules.default
              ({ pkgs, config, lib, ... }: {
                nixpkgs.hostPlatform = "x86_64-linux";
                nixpkgs.overlays = [
                  (import ./overlays/unstable.nix inputs)
                  (import ./modules/zmx).overlay
                  (import ./overlays/quickshell.nix inputs)
                  inputs.niri.overlays.niri
                ];
                system.configurationRevision = flakeRevision;

                services.axiom-deploy-annotation = {
                  enable = true;
                  tokenPath = config.sops.secrets."axiom/personal_token".path;
                  apiEndpoint = "https://api.axiom.co/v2/annotations";
                  datasets = [ "papertrail" "papertrail-traces" ];
                  repositoryUrl = "https://github.com/bdsqqq/dots";
                  user = "bdsqqq";
                  group = "users";
                };
                systemd.services.axiom-deploy-annotation.serviceConfig.ProtectHome =
                  lib.mkForce "read-only";
              })
              ./hosts/lgo-z2e/default.nix
            ];
          };

        };
      };
    };
}
