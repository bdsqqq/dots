{ config, lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  prismRoot = "${config.home-manager.users.bdsqqq.home.homeDirectory}/.local/share/PrismLauncher";
  prismConfig =
    "${config.my.paths.commonplace}/01_files/nix/modules/gaming/prismlauncher.cfg";
  prismInfoPlist = pkgs.writeText "prism-launcher-managed-info.plist"
    (lib.generators.toPlist { escape = true; } {
      CFBundleDisplayName = "Prism Launcher Managed";
      CFBundleExecutable = "prism-launcher-managed";
      CFBundleIdentifier = "dev.bdsqqq.prismlauncher-managed";
      CFBundleInfoDictionaryVersion = "6.0";
      CFBundleName = "Prism Launcher Managed";
      CFBundlePackageType = "APPL";
      CFBundleShortVersionString = "1.0";
      LSMinimumSystemVersion = "13.0";
      NSHighResolutionCapable = true;
    });
  prismLauncherManaged = pkgs.runCommand "prism-launcher-managed" { } ''
    app="$out/Applications/Prism Launcher Managed.app"
    mkdir -p "$app/Contents/MacOS"
    cp ${prismInfoPlist} "$app/Contents/Info.plist"
    cat > "$app/Contents/MacOS/prism-launcher-managed" <<'EOF'
    #!${pkgs.runtimeShell}
    exec "/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher" \
      --dir ${lib.escapeShellArg prismRoot} "$@"
    EOF
    chmod +x "$app/Contents/MacOS/prism-launcher-managed"
  '';

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
    environment.systemPackages = [ prismLauncherManaged ];
  })
  {
  home-manager.users.bdsqqq = { config, lib, pkgs, ... }: {
    home.packages =
      lib.optionals isLinux [ pkgs.prismlauncher steam-gamescope pkgs.gamescope ];

    home.file.".local/share/PrismLauncher/prismlauncher.cfg" =
      lib.mkIf isDarwin {
        source = config.lib.file.mkOutOfStoreSymlink prismConfig;
        force = true;
      };

    # The custom root keeps mutable launcher state out of the app bundle while
    # InstanceDir continues pointing at the existing Syncthing-owned directory.
    home.activation.seedPrismLauncherRoot =
      lib.mkIf isDarwin (lib.hm.dag.entryBefore [ "checkLinkTargets" ] ''
        root=${lib.escapeShellArg prismRoot}
        legacy="$HOME/Library/Application Support/PrismLauncher"
        marker="$root/.seeded-from-default-root"

        mkdir -p "$root"
        if [[ ! -e "$marker" && -d "$legacy" ]]; then
          ${pkgs.rsync}/bin/rsync -a \
            --exclude instances \
            --exclude prismlauncher.cfg \
            "$legacy/" "$root/"
          touch "$marker"
        fi
      '');
  };
  }
]
