{ config, lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  isSeedHost = (config.networking.localHostName or "") == "mbp-m2";
  vault = config.my.paths.commonplace;
  legacyProfile = "${vault}/.obsidian";
  desktopProfile = "${vault}/01_files/nix/modules/obsidian/desktop-profile";
  desktopProfileLink = "${vault}/.obsidian-desktop";
  mobileProfile = "${vault}/.obsidian-mobile";
in
lib.mkIf (headMode == "graphical") (lib.mkMerge [
  (lib.optionalAttrs isDarwin {
    homebrew.casks = [ "obsidian" ];
  })
  {
    home-manager.users.bdsqqq = { lib, ... }: {
      home.packages = lib.optionals isLinux [ pkgs.obsidian ];

      # Keep the conflict-heavy legacy profile intact. mbp-m2 seeds clean
      # desktop/mobile profiles once; subsequent edits belong to those profiles.
      home.activation.obsidianProfiles =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          legacy=${lib.escapeShellArg legacyProfile}
          desktop=${lib.escapeShellArg desktopProfile}
          desktop_link=${lib.escapeShellArg desktopProfileLink}
          mobile=${lib.escapeShellArg mobileProfile}

          ${
            lib.optionalString isSeedHost ''
              mkdir -p "$desktop"
              if [[ ! -e "$desktop/.seeded-from-legacy" && -d "$legacy" ]]; then
                ${pkgs.rsync}/bin/rsync -a \
                  --ignore-existing \
                  --exclude '.DS_Store' \
                  --exclude '*.sync-conflict-*' \
                  --exclude 'workspace*.json' \
                  "$legacy/" "$desktop/"
                touch "$desktop/.seeded-from-legacy"
              fi

              if [[ ! -e "$mobile/.seeded-from-legacy" && -d "$legacy" ]]; then
                mkdir -p "$mobile"
                ${pkgs.rsync}/bin/rsync -a \
                  --ignore-existing \
                  --exclude '.DS_Store' \
                  --exclude '*.sync-conflict-*' \
                  --exclude 'workspace.json' \
                  "$legacy/" "$mobile/"
                touch "$mobile/.seeded-from-legacy"
              fi
            ''
          }

          if [[ -e "$desktop_link" && ! -L "$desktop_link" ]]; then
            echo "$desktop_link exists and is not a symlink; refusing to replace it" >&2
            exit 1
          fi
          if [[ -d "$desktop" ]]; then
            ln -sfn "01_files/nix/modules/obsidian/desktop-profile" "$desktop_link"
          else
            echo "$desktop is not synced yet; desktop Obsidian profile not linked" >&2
          fi
        '';
    };
  }
])
