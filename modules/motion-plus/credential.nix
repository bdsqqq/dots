{ config, lib, ... }:
let
  cfg = config.my.motionPlus.credential;
in
{
  options.my.motionPlus.credential.required =
    lib.mkEnableOption "the Motion Plus API credential";

  config = lib.mkIf cfg.required {
    sops.secrets.motion_plus_token = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
