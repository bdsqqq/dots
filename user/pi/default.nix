{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  repoPi = "${homeDir}/commonplace/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions =
    "${homeDir}/commonplace/01_files/nix/user/pi/packages/extensions";
  repoAgentPrompts = "${homeDir}/commonplace/01_files/nix/user/agents/agents";
  authPath = "${homeDir}/.pi/agent/auth.json";
in {
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file.".pi/agent/settings.json".source =
      config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/settings.json";
    home.file.".pi/agent/tool-policy.json".source =
      config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/tool-policy.json";
    home.file.".pi/agent/keybindings.json".source =
      config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/keybindings.json";
    home.file.".pi/agent/models.json".source =
      config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/models.json";

    # extensions — single directory symlink, pi scans subdirectories for package.json with pi.extensions
    home.file.".pi/agent/extensions".source =
      config.lib.file.mkOutOfStoreSymlink "${repoExtensions}";

    # pi wrapper — run under node while resolving repo-local pnpm workspace packages.
    # pi's jiti extension loader creates require() scoped to the SYMLINK path
    # (~/.pi/agent/extensions/...), not the realpath (repo/extensions/...).
    # pnpm puts workspace package links in node_modules/.pnpm/node_modules, so
    # NODE_PATH must include that virtual root or symlinked extensions cannot
    # resolve @bds_pi/* imports under node.
    #
    # overwrites ~/.local/share/pnpm/pi with a wrapper script instead of using the
    # package-manager-generated bin shim. the wrapper preserves repo-local
    # extension resolution and keeps sub-agent spawns on the same runtime.
    #
    # CRITICAL: the wrapper exports PI_BIN pointing to itself. pi-spawn and
    # other sub-agent spawners must use $PI_BIN instead of "pi" to ensure
    # child processes use the same wrapper and NODE_PATH.
    home.activation.piNodeWrapper =
      lib.hm.dag.entryAfter [ "installPnpmGlobals" "installPiExtensionDeps" ] ''
        PNPM_HOME="${homeDir}/.local/share/pnpm"
        GLOBAL_DIR="$PNPM_HOME/global/5"
        PI_WRAPPER="$PNPM_HOME/pi"
        PI_CLI="$GLOBAL_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
        PI_MARIO_CLI="$GLOBAL_DIR/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
        if [ ! -e "$PI_CLI" ]; then
          PI_CLI="$PI_MARIO_CLI"
        fi
        if [ -e "$PI_CLI" ]; then
          rm -f "$PI_WRAPPER"
          printf '%s\n' '#!/usr/bin/env bash' "export NODE_PATH=\"${repoPi}/node_modules/.pnpm/node_modules:${repoPi}/node_modules\"" "export PI_BIN=\"$PI_WRAPPER\"" "exec ${pkgs.nodejs}/bin/node \"$PI_CLI\" \"\$@\"" > "$PI_WRAPPER"
          chmod +x "$PI_WRAPPER"
        fi
      '';

    # install workspace deps declaratively for all extension packages
    home.activation.installPiExtensionDeps =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        if [ -f "${repoPi}/package.json" ]; then
          export PATH="${lib.makeBinPath (
            [
              pkgs.nodejs
              pkgs.pnpm
              pkgs.python3
            ] ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.gcc
              pkgs.gnumake
            ]
          )}:$PATH"
          "${pkgs.pnpm}/bin/pnpm" install --dir "${repoPi}" --frozen-lockfile || true
        fi
      '';

    # agent definitions — shared plaintext prompt files from the repo
    home.file.".pi/agent/agents".source =
      config.lib.file.mkOutOfStoreSymlink "${repoAgentPrompts}";
  };
}
