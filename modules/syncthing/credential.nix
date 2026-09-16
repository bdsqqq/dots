{ config, lib, hostSystem ? null, ... }:
let
  cfg = config.my.syncthing.credential;
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  passwordFile = config.sops.secrets.syncthing_gui_password.path;
in
{
  options.my.syncthing.credential.required =
    lib.mkEnableOption "the shared Syncthing GUI credential";

  config = lib.mkIf cfg.required (lib.mkMerge [
    {
      sops.secrets.syncthing_gui_password = {
        sopsFile = ./secrets.yaml;
        owner = "bdsqqq";
        mode = "0400";
      };
    }
    (lib.optionalAttrs isLinux {
      services.syncthing = {
        guiPasswordFile = passwordFile;
        settings.gui.user = "bdsqqq";
      };
    })
    (lib.optionalAttrs isDarwin {
      home-manager.users.bdsqqq.services.syncthing.guiCredentials = {
        username = "bdsqqq";
        inherit passwordFile;
      };
    })
  ]);
}
