{ lib, config, pkgs, ... }:
let
  pnpmHomeRelative = if pkgs.stdenv.isDarwin then "/Library/pnpm" else "/.local/share/pnpm";
  manifestRepoPath = ../pnpm-global-package.json;
  lockRepoPath = ../pnpm-global-lock.yaml; # optional
  manifestJson = builtins.fromJSON (builtins.readFile manifestRepoPath);
  allowScripts = lib.concatStringsSep "," (builtins.attrNames (manifestJson.dependencies or {}));
in
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: let
    pnpmHomeAbsolute = "${config.home.homeDirectory}${pnpmHomeRelative}";
    pnpmGlobalRoot = "${pnpmHomeAbsolute}/global";
    pnpmGlobalDir = "${pnpmGlobalRoot}/5";
    manifestPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm-global-package.json";
    lockPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm-global-lock.yaml";
  in {
    # expose PNPM_HOME for all shells
    home.sessionVariables.PNPM_HOME = pnpmHomeAbsolute;
    home.sessionPath = lib.mkBefore [ pnpmHomeAbsolute ];

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

      # run a non-interactive global install against the linked manifest
      "${pkgs.pnpm}/bin/pnpm" install \
        --global \
        --global-dir "$GLOBAL_ROOT" \
        --config.only-built-dependencies="${allowScripts}" \
        --reporter append-only || true
    '';
  };
}


