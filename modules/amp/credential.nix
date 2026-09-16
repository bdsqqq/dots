{ config, lib, ... }:
let
  cfg = config.my.amp.credential;
in
{
  options.my.amp.credential.required =
    lib.mkEnableOption "the Amp API credential";

  config = lib.mkIf cfg.required {
    sops.secrets.amp_api_key = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
    my.amp.apiKeyFile = config.sops.secrets.amp_api_key.path;
  };
}
