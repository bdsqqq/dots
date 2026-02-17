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
      # and creates bin stubs in $BUN_INSTALL/bin
      "${pkgs.bun}/bin/bun" install \
        --cwd "$GLOBAL_DIR" || true
    '';

    # zsh-specific: re-assert bun precedence after fnm's dynamic PATH prepend
    programs.zsh.initContent = ''
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
