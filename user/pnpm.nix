{ inputs, lib, config, pkgs, ... }:
let
  pnpmHomeRelative = if pkgs.stdenv.isDarwin then "/Library/pnpm" else "/.local/share/pnpm";
  manifestRepoPath = ../pnpm-global-package.json;
  lockRepoPath = ../pnpm-global-lock.yaml; # optional
  manifestJson = builtins.fromJSON (builtins.readFile manifestRepoPath);
  allowScripts = lib.concatStringsSep "," (builtins.attrNames (manifestJson.dependencies or {}));
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
      # if a plain directory exists (from a previous run), replace it with a symlink
      if [ -d "$PNPM_HOME/5" ] && [ ! -L "$PNPM_HOME/5" ]; then
        # handle bad state where a nested symlink was created at $PNPM_HOME/5/5
        if [ -L "$PNPM_HOME/5/5" ]; then
          rm -f "$PNPM_HOME/5/5" || true
        fi
        rmdir "$PNPM_HOME/5" 2>/dev/null || true
      fi
      ln -sfn "$GLOBAL_DIR" "$PNPM_HOME/5"

      # compute allow-scripts from manifest at activation time
      JQ_BIN="${pkgs.jq}/bin/jq"
      ALLOW_SCRIPTS=$("$JQ_BIN" -r '(.dependencies // {}) | keys | join(",")' "$MANIFEST")

      # run a non-interactive global install against the linked manifest
      "${pkgs.pnpm}/bin/pnpm" install \
        --global \
        --global-dir "$GLOBAL_ROOT" \
        --config.only-built-dependencies="$ALLOW_SCRIPTS" \
        --reporter append-only || true

      # ensure shims are reachable on PATH: link executables to $PNPM_HOME
      BIN_SRC="$GLOBAL_ROOT/node_modules/.bin"
      if [ -d "$BIN_SRC" ]; then
        for exe in "$BIN_SRC"/*; do
          name="$(basename "$exe")"
          ln -sfn "$exe" "$PNPM_HOME/$name"
        done
      fi
    '';
  };
}


