{ lib, hostSystem ? null, ... }:
let isLinux = lib.hasInfix "linux" hostSystem;
in {
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }:
    let
      nvimConfig =
        "${config.home.homeDirectory}/commonplace/01_files/nix/user/nvim";
    in
    {
      home.packages = with pkgs;
        [
          neovim
          (writeShellScriptBin "vi" ''exec ${neovim}/bin/nvim "$@"'')
          (writeShellScriptBin "vim" ''exec ${neovim}/bin/nvim "$@"'')
          lazygit
          git
          curl
          gnumake
          cmake
          tree-sitter
        ] ++ lib.optionals isLinux [ wl-clipboard xsel gcc ];

      home.sessionVariables = {
        EDITOR = "nvim";
        VISUAL = "nvim";
      };

      home.shellAliases = {
        v = "nvim";
        vi = "nvim";
        vim = "nvim";
      };

      home.activation.removeLegacyNvimConfigDir =
        lib.hm.dag.entryBefore [ "checkLinkTargets" ] ''
          nvim_target="${config.xdg.configHome}/nvim"
          if [ -d "$nvim_target" ] && [ ! -L "$nvim_target" ]; then
            safe=1
            while IFS= read -r -d "" entry; do
              if [ ! -L "$entry" ]; then
                safe=0
                break
              fi
              link="$(readlink "$entry")"
              case "$link" in
                /nix/store/*-home-manager-files/.config/nvim/*) ;;
                *) safe=0; break ;;
              esac
            done < <(find "$nvim_target" -mindepth 1 -maxdepth 1 -print0)

            if [ "$safe" = 1 ]; then
              rm -rf "$nvim_target"
            else
              echo "refusing to replace non-home-manager nvim config directory: $nvim_target" >&2
              exit 1
            fi
          fi
        '';

      xdg.configFile."nvim" = {
        source = config.lib.file.mkOutOfStoreSymlink nvimConfig;
        force = true;
      };
    };
}
