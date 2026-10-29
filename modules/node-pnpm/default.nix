{ config, ... }:
let
  commonplace = config.my.paths.commonplace;
  toolsDir = "${commonplace}/01_files/nix/modules/node-pnpm";
  toolsBin = "${toolsDir}/node_modules/.bin";
  vpVersion = "1.3.0";
in
{
  home-manager.users.bdsqqq =
    { config
    , pkgs
    , lib
    , ...
    }:
    let
      # Keep our runtime current without changing unrelated packages' build inputs
      # and losing their upstream binary-cache matches.
      nodejs = pkgs.nodejs_latest;
      pnpm = pkgs.pnpm_12;
      # native -g uses separate install groups, not our tracked manifest.
      # route it to the live project so normal pnpm edits remain tracked without
      # a rebuild. keep the launcher, bin PATH and activation on the same source.
      pnpmLauncher = pkgs.writeShellScriptBin "pnpm" ''
        exec "${nodejs}/bin/node" "${toolsDir}/pnpm.mts" "${pnpm}/bin/pnpm" "$@"
      '';
      vpHome = "${config.home.homeDirectory}/.vite-plus";
      vpInstaller = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/voidzero-dev/vite-plus/afbe4a285b4ac6ffac498eae71b10ff63069a029/packages/cli/install.sh";
        hash = "sha256-bq8TnhbUWEm+vEp94NvCmS/Ts6hqPze/eSK2hfOmDZ4=";
      };
      activationPath = lib.makeBinPath (
        [
          nodejs
          pnpm
          pkgs.curl
          # Home Manager supplies the basic shell tools, but not awk, which
          # the Vite+ bootstrap uses to parse package metadata.
          pkgs.gawk
          pkgs.gzip
          pkgs.gnumake
          pkgs.gnutar
          pkgs.unzip
        ]
        ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [
          pkgs.gcc
        ]
      );
    in
    {
      custom.path.segments = [
        {
          order = 70;
          value = "${pnpmLauncher}/bin";
        }
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
        nodejs
        (lib.hiPrio pnpmLauncher)
        pnpm
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

        "${pnpm}/bin/pnpm" install \
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
