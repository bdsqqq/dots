{ config, lib, ... }:
let
  cfg = config.my.mymind.credential;
in
{
  options.my.mymind.credential.required =
    lib.mkEnableOption "the mymind API credentials";

  config = lib.mkIf cfg.required {
    sops.secrets = {
      mymind_keyid = {
        sopsFile = ./secrets.yaml;
        owner = "bdsqqq";
        mode = "0400";
      };
      mymind_privatekey = {
        sopsFile = ./secrets.yaml;
        owner = "bdsqqq";
        mode = "0400";
      };
    };
  };
}
