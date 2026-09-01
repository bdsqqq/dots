{ config, lib, hostSystem ? null, headMode ? "graphical", ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/zed";
in
lib.mkIf (headMode == "graphical" && isDarwin) {
  homebrew.casks = [ "zed" ];

  home-manager.users.bdsqqq = { config, lib, ... }: {
    home.file.".config/zed/settings.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/settings.json";
      force = true;
    };

    # Home Manager preserves an identical regular file instead of replacing it
    # with a link. Replace only byte-identical files so local edits are never lost.
    home.activation.zedMutableKeymap =
      lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        source=${lib.escapeShellArg "${repoConfig}/keymap.json"}
        target="$HOME/.config/zed/keymap.json"

        mkdir -p "$(dirname "$target")"
        if [[ -e "$target" && ! -L "$target" ]]; then
          if ! cmp -s "$source" "$target"; then
            echo "$target differs from $source; refusing to replace it" >&2
            exit 1
          fi
          rm "$target"
        fi
        ln -sfn "$source" "$target"
      '';
  };
}
