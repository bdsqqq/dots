{ config, lib, pkgs, headMode ? "graphical", hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/ghostty/config";
  ghosttyHome = {
    home-manager.users.bdsqqq = { config, ... }: {
      xdg.configFile."ghostty" = {
        source = config.lib.file.mkOutOfStoreSymlink repoConfig;
        force = true;
      };
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
