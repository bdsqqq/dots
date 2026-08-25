{ config, ... }:
let
  btopConfig = "${config.my.paths.commonplace}/01_files/nix/modules/btop/btop.conf";
in
{
  home-manager.users.bdsqqq =
    { config, pkgs, ... }:
    {
      home.packages = [ pkgs.btop ];

      xdg.configFile."btop/btop.conf" = {
        source = config.lib.file.mkOutOfStoreSymlink btopConfig;
        force = true;
      };
    };
}
