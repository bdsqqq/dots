{ ... }:
{
  home-manager.users.bdsqqq =
    {
      config,
      pkgs,
      lib,
      ...
    }:
    let
      pnpmHome = "${config.home.homeDirectory}/.local/share/pnpm";
      globalDir = "${pnpmHome}/global";
      manifestPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm/global-package.json";
      workspacePath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm/pnpm-workspace.yaml";
    in
    {
      home.sessionVariables.PNPM_HOME = pnpmHome;

      custom.path.segments = [
        {
          order = 100;
          value = pnpmHome;
        }
        {
          order = 110;
          value = "${globalDir}/node_modules/.bin";
        }
      ];

      home.packages = [
        pkgs.nodejs
        pkgs.pnpm
        pkgs.unzip
      ];

      home.activation.installPnpmGlobals = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        set -euo pipefail

        PNPM_HOME="${pnpmHome}"
        GLOBAL_DIR="${globalDir}"
        MANIFEST="${manifestPath}"
        WORKSPACE="${workspacePath}"
        export PNPM_HOME
        export PATH="${pnpmHome}:${pkgs.nodejs}/bin:${pkgs.pnpm}/bin:${pkgs.unzip}/bin:$PATH"

        mkdir -p "$PNPM_HOME" "$GLOBAL_DIR"

        # symlink manifest from repo — `pnpm add --dir "$GLOBAL_DIR" <pkg>` writes through.
        ln -sf "$MANIFEST" "$GLOBAL_DIR/package.json"
        ln -sf "$WORKSPACE" "$GLOBAL_DIR/pnpm-workspace.yaml"

        "${pkgs.pnpm}/bin/pnpm" install --dir "$GLOBAL_DIR" --prod || true

        if [ -d "$GLOBAL_DIR/node_modules/.bin" ]; then
          for bin in "$GLOBAL_DIR/node_modules/.bin"/*; do
            name="$(basename "$bin")"
            [ "$name" = "pi" ] && continue
            ln -sf "$bin" "$PNPM_HOME/$name"
          done
        fi
      '';
    };
}
