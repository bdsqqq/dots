{ lib, hostSystem ? null, ... }:
let isLinux = lib.hasInfix "linux" hostSystem;
in {
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }:
    let
      nvimConfig =
        "${config.home.homeDirectory}/commonplace/01_files/nix/user/nvim";
    in {
      home.packages = with pkgs;
        [
          neovim
          (writeShellScriptBin "vi" ''exec ${neovim}/bin/nvim "$@"'')
          (writeShellScriptBin "vim" ''exec ${neovim}/bin/nvim "$@"'')
          stylua
          go
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

      xdg.configFile."nvim" = {
        source = config.lib.file.mkOutOfStoreSymlink nvimConfig;
        force = true;
      };
    };
}
