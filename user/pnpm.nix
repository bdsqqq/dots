{ inputs, lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  pnpmHomeRelative = if isDarwin then "/Library/pnpm" else "/.local/share/pnpm";
in
{
  home-manager.users.bdsqqq = { inputs, config, pkgs, lib, ... }: let
    pnpmHomeAbsolute = "${config.home.homeDirectory}${pnpmHomeRelative}";
    pnpmGlobalRoot = "${pnpmHomeAbsolute}/global";
    pnpmGlobalDir = "${pnpmGlobalRoot}/5";
    # link from the working tree so `pnpm add -g` mutates the repo file directly
    manifestPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm-global-package.json";
    lockPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm-global-lock.yaml";
  in {
    # expose PNPM_HOME for all shells
    home.sessionVariables.PNPM_HOME = pnpmHomeAbsolute;
    home.sessionPath = lib.mkBefore [ pnpmHomeAbsolute "${pnpmGlobalDir}/node_modules/.bin" ];

    # ensure pnpm is installed for user
    home.packages = [ pkgs.pnpm ];

    home.activation.installPnpmGlobals = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail
      PNPM_HOME="${pnpmHomeAbsolute}"
      export PNPM_HOME
      export PATH="$PNPM_HOME:$PATH"

      GLOBAL_ROOT="${pnpmGlobalRoot}"
      GLOBAL_DIR="${pnpmGlobalDir}"
      MANIFEST="${manifestPath}"
      LOCKFILE="${lockPath}"

      mkdir -p "$GLOBAL_DIR"

      # symlink manifest and optional lockfile
      ln -sf "$MANIFEST" "$GLOBAL_DIR/package.json"
      if [ -f "$LOCKFILE" ]; then
        ln -sf "$LOCKFILE" "$GLOBAL_DIR/pnpm-lock.yaml"
      fi

      # ensure versioned dir link (pnpm expects $PNPM_HOME/5)
      ln -sfn "$GLOBAL_DIR" "$PNPM_HOME/5"

      # purge stale shims so pnpm regenerates them pointing to current versions
      # pnpm doesn't rewrite shims if they already exist, leading to stale references
      if [ -d "$PNPM_HOME" ]; then
        find "$PNPM_HOME" -maxdepth 1 -type f -print -delete
      fi

      # run a non-interactive global install against the linked manifest
      # this operates on the symlinked package.json/lock, keeping them as source of truth
      "${pkgs.pnpm}/bin/pnpm" install \
        --global \
        --global-dir "$GLOBAL_ROOT" \
        --reporter append-only || true

      # shims are available via PATH entry to "$GLOBAL_DIR/node_modules/.bin"
    '';
  };
}


