{ inputs, lib, hostSystem ? null, ... }:
{
  home-manager.users.bdsqqq = { inputs, config, pkgs, lib, ... }: let
    bunInstall = "${config.home.homeDirectory}/.bun";
    bunBin = "${bunInstall}/bin";
    globalDir = "${bunInstall}/install/global";
    # link from the working tree so `bun add -g` mutates the repo file directly
    manifestPath = "${config.home.homeDirectory}/commonplace/01_files/nix/bun/global-package.json";
  in {
    home.sessionVariables.BUN_INSTALL = bunInstall;

    # contribute to central path ordering (low order = early in PATH = wins)
    custom.path.segments = [
      { order = 100; value = bunBin; }
      { order = 110; value = "${globalDir}/node_modules/.bin"; }
    ];

    # bun from nixpkgs (replaces the npm-distributed `bun` package)
    home.packages = [ pkgs.bun ];

    home.activation.installBunGlobals = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail
      BUN_INSTALL="${bunInstall}"
      export BUN_INSTALL
      export PATH="${bunBin}:$PATH"

      GLOBAL_DIR="${globalDir}"
      MANIFEST="${manifestPath}"

      mkdir -p "$GLOBAL_DIR"

      # symlink manifest from repo — bun add -g writes through to the repo file
      ln -sf "$MANIFEST" "$GLOBAL_DIR/package.json"

      # install globals; bun resolves deps into $GLOBAL_DIR/node_modules
      "${pkgs.bun}/bin/bun" install \
        --cwd "$GLOBAL_DIR" || true

      # bun install --cwd doesn't create bin stubs in ~/.bun/bin (only bun add -g does)
      # mirror what pnpm --global did: link node_modules/.bin/* → ~/.bun/bin/
      BUN_BIN="${bunBin}"
      mkdir -p "$BUN_BIN"
      if [ -d "$GLOBAL_DIR/node_modules/.bin" ]; then
        for bin in "$GLOBAL_DIR/node_modules/.bin"/*; do
          name="$(basename "$bin")"
          # don't clobber bun/bunx themselves
          [ "$name" = "bun" ] || [ "$name" = "bunx" ] && continue
          ln -sf "$bin" "$BUN_BIN/$name"
        done
      fi
    '';

    # configure bun's global dirs so interactive `bun add -g` creates bin
    # links in ~/.bun/bin and writes to the symlinked manifest
    home.file.".bunfig.toml".text = ''
      [install]
      globalDir = "${globalDir}"
      globalBinDir = "${bunBin}"
    '';

    # zsh-specific: re-assert bun precedence after fnm's dynamic PATH prepend
    programs.zsh.initContent = ''
      [ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"
      # fnm prepends at runtime; ensure bun wins by re-prepending after shell init
      if [[ -n "$BUN_INSTALL" ]]; then
        typeset -U path  # enable deduplication
        path=(
          "$BUN_INSTALL/bin"
          "$BUN_INSTALL/install/global/node_modules/.bin"
          ''${path[@]}
        )
      fi
    '';
  };
}
