{
  lib,
  inputs,
  hostSystem ? null,
  ...
}:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  repoPi = "${homeDir}/commonplace/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions = "${homeDir}/commonplace/01_files/nix/user/pi/packages/extensions";
  repoAgentPrompts = "${homeDir}/commonplace/01_files/nix/user/agents/agents";
in
{
  home-manager.users.bdsqqq =
    {
      pkgs,
      config,
      lib,
      ...
    }:
    {
      home.file.".pi/agent/settings.json".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/settings.json";
      home.file.".pi/agent/tool-policy.json".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/tool-policy.json";
      home.file.".pi/agent/keybindings.json".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/keybindings.json";
      home.file.".pi/agent/models.json".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/models.json";

      # extensions — single directory symlink, pi scans subdirectories for package.json with pi.extensions
      home.file.".pi/agent/extensions".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}";

      # pi loads TypeScript extensions directly via jiti, so local development can
      # stay source-first. The wrapper only patches module resolution for this
      # repo's pnpm workspace layout: some symlinked extension entrypoints resolve
      # @bds_pi/* through node_modules/.pnpm/node_modules, which is not on Node's
      # default lookup path from ~/.pi/agent/extensions.
      #
      # overwrites ~/.local/share/pnpm/bin/pi with a wrapper script instead of using the
      # package-manager-generated bin shim. the wrapper preserves repo-local
      # extension resolution and keeps sub-agent spawns on the same runtime.
      #
      # CRITICAL: the wrapper exports PI_BIN pointing to itself. pi-spawn and
      # other sub-agent spawners must use $PI_BIN instead of "pi" to ensure
      # child processes use the same wrapper and NODE_PATH.
      home.activation.piNodeWrapper =
        lib.hm.dag.entryAfter [ "installPnpmGlobals" "installPiExtensionDeps" ]
          ''
            PNPM_HOME="${homeDir}/.local/share/pnpm"
            PNPM_BIN="$PNPM_HOME/bin"
            GLOBAL_DIR="$PNPM_HOME/global/5"
            PI_WRAPPER="$PNPM_BIN/pi"
            PI_CLI="$GLOBAL_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
            if [ -e "$PI_CLI" ]; then
              mkdir -p "$PNPM_BIN"
              rm -f "$PI_WRAPPER"
              printf '%s\n' '#!/usr/bin/env bash' "export NODE_PATH=\"${repoPi}/node_modules/.pnpm/node_modules:${repoPi}/node_modules\"" "export PI_BIN=\"$PI_WRAPPER\"" "exec ${pkgs.nodejs}/bin/node \"$PI_CLI\" \"\$@\"" > "$PI_WRAPPER"
              chmod +x "$PI_WRAPPER"
            fi
          '';

      # install workspace deps declaratively for all extension packages
      home.activation.installPiExtensionDeps = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        set -euo pipefail

        if [ -f "${repoPi}/package.json" ]; then
          export PNPM_HOME="${homeDir}/.local/share/pnpm"
          export PATH="${
            lib.makeBinPath (
              [
                pkgs.nodejs
                pkgs.pnpm
                pkgs.python3
              ]
              ++ lib.optionals pkgs.stdenv.isLinux [
                pkgs.gcc
                pkgs.gnumake
              ]
            )
          }:$PATH"
          "${pkgs.pnpm}/bin/pnpm" install --dir "${repoPi}" --frozen-lockfile
        fi
      '';

      # agent definitions — shared plaintext prompt files from the repo
      home.file.".pi/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${repoAgentPrompts}";
    };
}
