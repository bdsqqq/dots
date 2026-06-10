{ lib, hostSystem ? null, headMode ? "graphical", ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
in lib.mkIf (isLinux && headMode == "graphical") {
  home-manager.users.bdsqqq = { config, lib, ... }:
    let
      themeDir = "${config.home.homeDirectory}/commonplace/01_files/nix/user/themes/e-ink-glass";
    in {
      xdg.configFile = {
        "Kvantum/kvantum.kvconfig" = {
          text = ''
           [General]
           theme=EInkGlass
          '';
          force = true;
        };
        "Kvantum/EInkGlass" = {
          source = config.lib.file.mkOutOfStoreSymlink "${themeDir}/Kvantum/EInkGlass";
          recursive = true;
        };
      };
    };
}
