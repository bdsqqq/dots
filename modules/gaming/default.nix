{ config, lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  prismHost = config.networking.localHostName or config.networking.hostName;
  prismHome = config.home-manager.users.bdsqqq.home.homeDirectory;
  # Prism persists architecture, window state, and macOS security bookmarks in
  # its main cfg, so each host owns a separate mutable repository file.
  prismConfig =
    "${config.my.paths.commonplace}/01_files/nix/modules/gaming/prismlauncher/${prismHost}.cfg";
  prismConfigRoot =
    if isDarwin then
      "${prismHome}/Library/Application Support/PrismLauncher"
    else
      "${prismHome}/.local/share/PrismLauncher";

  # launch steam big picture in gamescope to avoid gesture conflicts with niri
  steam-gamescope = pkgs.writeShellScriptBin "steam-gamescope" ''
    exec ${pkgs.gamescope}/bin/gamescope \
      -e \
      -f \
      --adaptive-sync \
      --expose-wayland \
      -- steam -gamepadui -steamos
  '';
in
lib.mkMerge [
  (lib.optionalAttrs isDarwin {
    homebrew.casks = [ "prismlauncher" ];
  })
  {
  home-manager.users.bdsqqq = { lib, pkgs, ... }: {
    home.packages =
      lib.optionals isLinux [ pkgs.prismlauncher steam-gamescope pkgs.gamescope ];

    # Seed a new host from its existing local cfg, then use a direct link so the
    # normal app writes back to the working tree without a launcher wrapper.
    home.activation.linkPrismLauncherConfig =
      lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        source=${lib.escapeShellArg prismConfig}
        target=${lib.escapeShellArg "${prismConfigRoot}/prismlauncher.cfg"}

        if [[ -v DRY_RUN ]]; then
          echo "would link $target to $source"
        else
          mkdir -p "$(dirname "$source")" "$(dirname "$target")"
          if [[ ! -e "$source" ]]; then
            if [[ -f "$target" ]]; then
              cp "$target" "$source"
            else
              touch "$source"
            fi
          fi

          if [[ -e "$target" && ! -L "$target" ]]; then
            if ! cmp -s "$source" "$target"; then
              echo "$target differs from $source; refusing to replace it" >&2
              exit 1
            fi
            rm "$target"
          fi
          ln -sfn "$source" "$target"
        fi
      '';
  };
  }
]
