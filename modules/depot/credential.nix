{ config, lib, ... }:
{
  options.my.depot.credential.required =
    lib.mkEnableOption "the Depot organization credential";

  config = lib.mkIf config.my.depot.credential.required {
    sops.secrets.depot_org_token = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
