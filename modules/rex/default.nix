{ config, lib, hostSystem ? null, headMode ? "graphical", ... }:
let
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/rex/config";
in
lib.mkIf (headMode == "graphical" && lib.hasInfix "darwin" hostSystem) {
  home-manager.users.bdsqqq = { config, ... }: {
    xdg.configFile."rex".source = config.lib.file.mkOutOfStoreSymlink repoConfig;
  };
}
