{ config, ... }:
let
  commonplace = config.my.paths.commonplace;
  toolsDir = "${commonplace}/01_files/nix/modules/node-pnpm";
  toolsBin = "${toolsDir}/node_modules/.bin";
  vpVersion = "0.2.2";
in
{
  nixpkgs.overlays = [
    (
      final: prev:
      prev.lib.optionalAttrs prev.stdenv.hostPlatform.isDarwin {
        pnpm = final.pnpm_11;
        # pnpm 11's frozen fetch aborts on Darwin with Node 24.16 (unmanaged
        # file descriptors, then SIGABRT). The same fetch passes on Node 22.
        # Only pnpm's interpreter changes; applications keep their chosen Node.
        pnpm_11 = prev.pnpm_11.override { nodejs-slim = prev.nodejs_22; };
      }
    )
  ];

  home-manager.users.bdsqqq =
    { config
    , pkgs
    , lib
    , ...
    }:
    let
      vpHome = "${config.home.homeDirectory}/.vite-plus";
      vpInstaller = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/voidzero-dev/vite-plus/4f7fd0b66ebb5433acdb06f8660cf0f08c5a0d4b/packages/cli/install.sh";
        hash = "sha256-iwqYNdhxxOZ67hyNW35ALRZctVoyInQ1Z6RDAoszSS4=";
      };
      activationPath = lib.makeBinPath (
        [
          pkgs.nodejs
          pkgs.pnpm
          pkgs.curl
          pkgs.gzip
          pkgs.gnumake
          pkgs.gnutar
          pkgs.unzip
        ]
        ++ lib.optionals pkgs.stdenv.isLinux [
          pkgs.gcc
        ]
      );
    in
    {
      custom.path.segments = [
        {
          order = 90;
          value = "${vpHome}/bin";
        }
        {
          order = 100;
          value = toolsBin;
        }
      ];

      home.packages = [
        pkgs.nodejs
        pkgs.pnpm
        pkgs.unzip
      ];

      xdg.configFile."pnpm/config.yaml" = {
        force = true;
        source = ./config.yaml;
      };

      home.activation.installPnpmTools = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        set -euo pipefail

        export CI=true
        export NODE_NO_WARNINGS=1
        export PATH="${activationPath}:$PATH"

        "${pkgs.pnpm}/bin/pnpm" install \
          --dir "${toolsDir}" \
          --frozen-lockfile \
          --reporter=append-only
      '';

      home.activation.installVitePlus = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        set -euo pipefail

        if [ "$(readlink "${vpHome}/current" 2>/dev/null || true)" != "${vpVersion}" ] \
          || [ ! -x "${vpHome}/current/bin/vp" ] \
          || [ ! -x "${vpHome}/bin/vp" ]; then
          (
            isolated_home="$(mktemp -d)"
            trap 'rm -rf "$isolated_home"' EXIT

            HOME="$isolated_home" \
              XDG_CONFIG_HOME="$isolated_home/.config" \
              ZDOTDIR="$isolated_home/.config/zsh" \
              PATH="${activationPath}:$PATH" \
              VP_HOME="${vpHome}" \
              VP_VERSION="${vpVersion}" \
              VP_NODE_MANAGER=no \
              CI=true \
              "${pkgs.bash}/bin/bash" "${vpInstaller}"
          )
        fi
      '';
    };
}
