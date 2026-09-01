{ config, lib, pkgs, headMode ? "graphical", hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/ghostty/config";
  configFiles = [
    "config"
    "themes/compline-dark"
    "themes/lauds-light"
    "themes/vesper-dark"
    "themes/vesper-light"
  ];
  ghosttyHome = {
    home-manager.users.bdsqqq = { config, ... }: {
      xdg.configFile = lib.genAttrs
        (map (name: "ghostty/${name}") configFiles)
        (name: {
          source = config.lib.file.mkOutOfStoreSymlink
            "${repoConfig}/${lib.removePrefix "ghostty/" name}";
          force = true;
        });
    };
  };

in lib.mkIf (headMode == "graphical") (if isDarwin then lib.mkMerge [ ghosttyHome {
  homebrew.casks = [ "ghostty" ];
  home-manager.users.bdsqqq = {
    home.sessionVariables.TERMINFO_DIRS =
      "/Applications/Ghostty.app/Contents/Resources/terminfo:/usr/share/terminfo";
  };
} ] else if isLinux then lib.mkMerge [ ghosttyHome {
  home-manager.users.bdsqqq.home.packages = [ pkgs.ghostty ];
} ] else
  { })
